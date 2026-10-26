# AutoStream

A [Vencord](https://github.com/Vendicated/Vencord) user plugin for Go Live streams.

- **Auto-opens streams** in your current voice channel or DM call, including ones already running when you join.
- **Keeps the grid view.** New streams open without being focused, so you can see all of them at once.
- **Closed streams stay closed.** If you close someone's stream, their streams won't auto-open again (tracked by user ID, across calls, rejoins and restarts). Opening their stream again by hand removes them from that list.

## Install

User plugins require a [Vencord build from source](https://docs.vencord.dev/installing/custom-plugins/).

```bash
cd Vencord
git clone https://github.com/DarkFantom10/vencord-autostream src/userplugins/autoStream
pnpm build
```

Restart Discord, then enable **AutoStream** in Settings → Vencord → Plugins.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Keep grid view | On | If Discord focuses a stream the plugin just opened (DM calls can do this), switch back to the grid. |
| Show toasts | On | Show a toast when a streamer is added to or removed from the closed list. |
| Streamers kept closed | — | Lists closed streamers, with buttons to allow one again or clear the list. |

## How a "close" is detected

Discord fires the same close event when you leave a call, when a streamer ends their stream, or on reconnects. A close only counts as yours if, 1.5 seconds later, you're still in that channel, the streamer is still live, you haven't reopened it, and there was no reconnect, channel change or server-side stream end around it.
