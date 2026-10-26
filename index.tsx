/*
 * AutoStream — Vencord user plugin
 *
 * 1. Auto-opens every Go Live stream in your current voice channel / call.
 * 2. Opens them without focusing (grid / "zoomed out" view stays as-is).
 * 3. If you close someone's stream, that user ID is remembered and their streams
 *    stay closed (new calls, rejoins, restarts). Opening their stream again by hand
 *    removes them from that list.
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationStream } from "@vencord/discord-types";
import {
    ApplicationStreamingStore,
    ChannelRTCStore,
    FluxDispatcher,
    SelectedChannelStore,
    showToast,
    useEffect,
    useReducer,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

const DATA_KEY = "AutoStream_closedUsers";
const RECONCILE_DEBOUNCE_MS = 250;
const WATCH_RETRY_COOLDOWN_MS = 10_000;
// Wait before deciding a STREAM_CLOSE was the user's doing, so leave/switch/stream-end events land first.
const CLOSE_VERIFY_DELAY_MS = 1_500;
// STREAM_CLOSEs this close to a voice-channel change or gateway reconnect are treated as automatic.
const CLOSE_CHANNEL_CHANGE_GRACE_MS = 1_000;
const CLOSE_CONNECTION_GRACE_MS = 5_000;
// A focus on an auto-opened stream within this window after opening is treated as Discord's, not the user's.
const AUTO_FOCUS_WINDOW_MS = 750;
const UNFOCUS_CHECK_DELAYS_MS = [250, 1_000, 3_000];

const logger = new Logger("AutoStream");

const settings = definePluginSettings({
    keepGridView: {
        type: OptionType.BOOLEAN,
        description: "Return to the grid view if Discord focuses a stream this plugin just opened",
        default: true
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when a streamer is added to or removed from the closed list",
        default: true
    },
    closedUsers: {
        type: OptionType.COMPONENT,
        component: () => <ClosedUsersList />
    }
});

/** Owner user IDs whose streams the user closed. Persisted in DataStore. */
let closedUsers = new Set<string>();
/** streamKey -> last time this plugin dispatched STREAM_WATCH for it. */
const requestedAt = new Map<string, number>();
/** Streams with a STREAM_CLOSE awaiting verification; never auto-reopened meanwhile. */
const pendingCloses = new Set<string>();
/** streamKey -> time of the last STREAM_WATCH (ours or the user's). */
const lastWatchAt = new Map<string, number>();
/** streamKey -> time of the last server STREAM_DELETE (stream ended / refused). */
const lastDeleteAt = new Map<string, number>();

const timers = new Set<ReturnType<typeof setTimeout>>();
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let lastVoiceChannelChangeAt = 0;
let lastConnectionEventAt = 0;
let lastUserSelect = { id: null as string | null, at: 0 };
let dispatchingOwnSelect = false;
let running = false;
let loaded = false;

const listeners = new Set<() => void>();

interface StreamKeyInfo {
    channelId: string;
    ownerId: string;
}

// Stream keys: "guild:<guildId>:<channelId>:<ownerId>" or "call:<channelId>:<ownerId>"
function parseStreamKey(key: unknown): StreamKeyInfo | null {
    if (typeof key !== "string") return null;
    const parts = key.split(":");
    if (parts[0] === "guild" && parts.length === 4) return { channelId: parts[2], ownerId: parts[3] };
    if (parts[0] === "call" && parts.length === 3) return { channelId: parts[1], ownerId: parts[2] };
    return null;
}

function encodeStreamKey(stream: ApplicationStream): string {
    return stream.guildId
        ? `guild:${stream.guildId}:${stream.channelId}:${stream.ownerId}`
        : `call:${stream.channelId}:${stream.ownerId}`;
}

function myId(): string | undefined {
    return UserStore.getCurrentUser()?.id;
}

function later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
        timers.delete(t);
        if (!running) return;
        try {
            fn();
        } catch (e) {
            logger.error("Deferred task failed", e);
        }
    }, ms);
    timers.add(t);
}

function toast(msg: string) {
    if (!settings.store.showToasts) return;
    try {
        showToast({ text: msg });
    } catch (e) {
        logger.warn("Toast failed", e);
    }
}

function displayName(userId: string): string {
    const user = UserStore.getUser(userId);
    return user?.globalName ?? user?.username ?? userId;
}

function liveStreams(channelId: string): ApplicationStream[] {
    try {
        return ApplicationStreamingStore.getAllApplicationStreamsForChannel(channelId) ?? [];
    } catch (e) {
        logger.error("Could not read streams for channel", channelId, e);
        return [];
    }
}

function isLive(info: StreamKeyInfo): boolean {
    return liveStreams(info.channelId).some(s => s.ownerId === info.ownerId);
}

/** True while a stream tile exists for the key, except ENDED leftovers (so a restarted stream reopens). FAILED counts, to avoid retry loops. */
function isWatching(streamKey: string): boolean {
    try {
        const stream = ApplicationStreamingStore.getActiveStreamForStreamKey(streamKey) as { state?: string; } | null;
        return stream != null && stream.state !== "ENDED";
    } catch (e) {
        logger.error("Could not read active stream", streamKey, e);
        return true; // unknown -> don't try to open it
    }
}

function isMarkedFull(streamKey: string): boolean {
    try {
        return ApplicationStreamingStore.isStreamMarkedFull(streamKey) === true;
    } catch {
        return false;
    }
}

// --- closed list ---------------------------------------------------------------

function persistClosed() {
    DataStore.set(DATA_KEY, [...closedUsers]).catch(e => logger.error("Failed to save closed list", e));
    listeners.forEach(l => {
        try {
            l();
        } catch { /* settings UI unmounted */ }
    });
}

function addClosed(ownerId: string) {
    if (closedUsers.has(ownerId)) return;
    closedUsers.add(ownerId);
    persistClosed();
    toast(`AutoStream: ${displayName(ownerId)}'s streams will stay closed`);
}

function removeClosed(ownerId: string) {
    if (!closedUsers.delete(ownerId)) return;
    persistClosed();
    toast(`AutoStream: ${displayName(ownerId)}'s streams will auto-open again`);
    scheduleReconcile();
}

function clearClosed() {
    if (!closedUsers.size) return;
    closedUsers.clear();
    persistClosed();
    scheduleReconcile();
}

// --- opening streams -------------------------------------------------------------

function scheduleReconcile(delay = RECONCILE_DEBOUNCE_MS) {
    if (!running) return;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined;
        if (!running) return;
        try {
            reconcile();
        } catch (e) {
            logger.error("Reconcile failed", e);
        }
    }, delay);
}

/** Open every live stream in the current voice channel that isn't open, closed by the user, or full. */
function reconcile() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    const me = myId();
    if (!loaded || !channelId || !me) return;
    // Only once our own voice state is in the channel; the server refuses watches before that.
    if (VoiceStateStore.getVoiceStateForChannel(channelId, me) == null) return;

    const streams = liveStreams(channelId);
    const liveKeys = new Set(streams.map(encodeStreamKey));
    for (const key of requestedAt.keys()) if (!liveKeys.has(key)) requestedAt.delete(key);

    const now = Date.now();
    for (const stream of streams) {
        const key = encodeStreamKey(stream);
        if (stream.ownerId === me || closedUsers.has(stream.ownerId)) continue;
        if (pendingCloses.has(key) || isWatching(key) || isMarkedFull(key)) continue;
        if (now - (requestedAt.get(key) ?? 0) < WATCH_RETRY_COOLDOWN_MS) continue;
        openStream(stream.channelId, key);
    }
}

function openStream(channelId: string, streamKey: string) {
    requestedAt.set(streamKey, Date.now());
    try {
        // Raw dispatch instead of Discord's watchStream(): that helper also calls selectParticipant (focus).
        FluxDispatcher.dispatch({ type: "STREAM_WATCH", streamKey, allowMultiple: true });
    } catch (e) {
        logger.error("Failed to open stream", streamKey, e);
        return;
    }
    if (settings.store.keepGridView) guardAgainstFocus(channelId, streamKey);
}

/** If Discord focuses the stream we just opened (e.g. DM calls default to auto-focus), drop back to grid. */
function guardAgainstFocus(channelId: string, streamKey: string) {
    const openedAt = Date.now();
    for (const delay of UNFOCUS_CHECK_DELAYS_MS) {
        later(() => {
            if (ChannelRTCStore.getSelectedParticipantId(channelId) !== streamKey) return;
            const userFocusedIt = lastUserSelect.id === streamKey && lastUserSelect.at - openedAt > AUTO_FOCUS_WINDOW_MS;
            if (userFocusedIt) return;
            dispatchingOwnSelect = true;
            try {
                FluxDispatcher.dispatch({ type: "CHANNEL_RTC_SELECT_PARTICIPANT", channelId, id: null });
            } finally {
                dispatchingOwnSelect = false;
            }
        }, delay);
    }
}

// --- detecting user closes -------------------------------------------------------

function verifyClose(streamKey: string, info: StreamKeyInfo, closedAt: number) {
    if (lastConnectionEventAt >= closedAt - CLOSE_CONNECTION_GRACE_MS) return; // gateway reconnect churn
    if (lastVoiceChannelChangeAt >= closedAt - CLOSE_CHANNEL_CHANGE_GRACE_MS) return; // left / switched / rejoined
    if (SelectedChannelStore.getVoiceChannelId() !== info.channelId) return;
    if (!isLive(info)) return; // streamer ended it, not us
    if (isWatching(streamKey)) return; // already reopened
    addClosed(info.ownerId);
}

// --- settings UI -------------------------------------------------------------------

function ClosedUsersList() {
    const [, rerender] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        listeners.add(rerender);
        return () => void listeners.delete(rerender);
    }, []);

    const textStyle = { color: "var(--text-default, var(--text-normal))" };
    const ids = [...closedUsers];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ ...textStyle, fontWeight: 600 }}>Streamers kept closed ({ids.length})</span>
            {ids.length === 0
                ? <span style={textStyle}>None. Closing someone's stream in a call adds them here.</span>
                : ids.map(id => (
                    <div key={id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={textStyle}>{displayName(id)} <small style={{ opacity: 0.6 }}>({id})</small></span>
                        <Button size="small" variant="secondary" onClick={() => removeClosed(id)}>Auto-open again</Button>
                    </div>
                ))}
            {ids.length > 0 && (
                <Button size="small" variant="dangerSecondary" onClick={clearClosed}>Clear list</Button>
            )}
        </div>
    );
}

// --- plugin ----------------------------------------------------------------------

export default definePlugin({
    name: "AutoStream",
    description: "Auto-opens Go Live streams in your voice channel without focusing them; streams you close stay closed per user until you reopen them.",
    authors: [{ name: "DarkFantom10", id: 0n }],
    settings,

    async start() {
        running = true;
        try {
            const saved = await DataStore.get<string[]>(DATA_KEY);
            // Merge: a close detected while loading must not be lost.
            if (Array.isArray(saved)) closedUsers = new Set([...saved.filter(id => typeof id === "string"), ...closedUsers]);
        } catch (e) {
            logger.error("Failed to load closed list", e);
        }
        loaded = true;
        scheduleReconcile();
    },

    stop() {
        running = false;
        loaded = false;
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = undefined;
        timers.forEach(clearTimeout);
        timers.clear();
        requestedAt.clear();
        pendingCloses.clear();
        lastWatchAt.clear();
        lastDeleteAt.clear();
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates?: Array<{ userId?: string; channelId?: string | null; }>; }) {
            const vc = SelectedChannelStore.getVoiceChannelId();
            if (!vc) return;
            const me = myId();
            if (voiceStates?.some(s => s.userId === me || s.channelId === vc)) scheduleReconcile();
        },

        VOICE_CHANNEL_SELECT() {
            lastVoiceChannelChangeAt = Date.now();
            requestedAt.clear();
            scheduleReconcile();
        },

        CONNECTION_OPEN() {
            lastConnectionEventAt = Date.now();
            scheduleReconcile(1_000);
        },

        CONNECTION_CLOSED() {
            lastConnectionEventAt = Date.now();
        },

        STREAM_WATCH({ streamKey }: { streamKey: string; }) {
            const info = parseStreamKey(streamKey);
            if (!info) return;
            lastWatchAt.set(streamKey, Date.now());
            // This plugin never opens a closed user's stream, so this watch came from the user: reopened.
            if (closedUsers.has(info.ownerId)) removeClosed(info.ownerId);
        },

        STREAM_CLOSE({ streamKey }: { streamKey: string; }) {
            const info = parseStreamKey(streamKey);
            if (!info || info.ownerId === myId()) return;
            // Server deleted it since it was last watched -> closing an ended/refused tile, not a live stream.
            // (A user close is CLOSE then maybe DELETE; a stream ending is DELETE then maybe CLOSE.)
            const deletedAt = lastDeleteAt.get(streamKey);
            if (deletedAt != null && deletedAt >= (lastWatchAt.get(streamKey) ?? 0)) return;
            const closedAt = Date.now();
            pendingCloses.add(streamKey);
            later(() => {
                pendingCloses.delete(streamKey);
                verifyClose(streamKey, info, closedAt);
            }, CLOSE_VERIFY_DELAY_MS);
        },

        STREAM_DELETE({ streamKey, unavailable }: { streamKey: string; unavailable?: boolean; }) {
            if (!unavailable) lastDeleteAt.set(streamKey, Date.now());
        },

        CHANNEL_RTC_SELECT_PARTICIPANT({ id }: { id?: string | null; }) {
            if (!dispatchingOwnSelect) lastUserSelect = { id: id ?? null, at: Date.now() };
        }
    }
});
