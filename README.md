# AgentDeck

**[English](README.md)** | [简体中文](README.zh-CN.md)

**One screen. Four terminals. Any AI coding agent.**

Stop juggling terminal tabs. AgentDeck gives you a 2×2 grid of real terminals in your browser — launch [pi](https://pi.dev), [Claude Code](https://claude.com/product/claude-code), [Codex](https://openai.com/codex), Gemini CLI, Aider, or a plain shell in any pane, and drive them all from one page.

```
┌─────────────────┬─────────────────┐
│  π pi           │  ✳ claude       │
│  ~/my-app       │  ~/my-app       │
│                 │                 │
├─────────────────┼─────────────────┤
│  ◆ codex        │  >_ zsh         │
│  ~/infra        │  ~/scratch      │
└─────────────────┴─────────────────┘
        ⌨  ← hover the dock, broadcast to all four at once
```

## Why

Running multiple coding agents in parallel means N terminal windows, N tabs, endless ⌘-Tab. AgentDeck keeps every agent visible at once, lets you talk to one or all of them from a single input, and keeps processes alive across page refreshes.

## Quick start

```bash
git clone https://github.com/flashclub/agent-deck.git
cd agent-deck
npm install
node server.mjs
# open http://127.0.0.1:7788
```

Requirements: Node ≥ 22, macOS / Linux. No build step, no config file.

Agents are **auto-detected** from your machine (`command -v`): pi, Claude Code, Codex, Gemini CLI, Aider, plus a login shell. Add your own in `detectAgents()` in `server.mjs`.

## Features

- **Real terminals** — node-pty + xterm.js. Full ANSI / 256-color / full-screen TUI rendering; every agent shortcut works exactly as locally.
- **Survives refresh & reconnect** — panes are server-side PTYs with ~160KB output replay per pane. Close the tab, come back, keep going.
- **Caster dock** — hover the ⌨ dock at the bottom:
  - `Tab` / `Shift+Tab` cycle targets (All → pane 1..4, skips stopped panes)
  - `Enter` sends to the selected pane
  - `⌘/Ctrl+Enter` broadcasts to **all** running agents at once
  - receiving panes flash; `Esc` collapses and returns focus to the terminal
- **English & Chinese UI** — one-click switch in the toolbar (auto-detected from your browser), every string localized.
- **Collapsible toolbar** — hide the top bar for maximum terminal real estate; a small ⌃ button brings it back.
- **Light & dark themes** — tuned terminal palettes for both, persisted; adjustable terminal font size (12–24px).
- **Per-pane controls** — click to focus, `⤢` maximize, `↻` restart, `✕` close; status dot pulses while output is flowing.
- **Smart cwd picker** — optionally offers recent project directories read from pi's local session library (see Privacy).
- **Custom dialogs & toasts** — no native `alert()` anywhere.

## Keyboard map

| Key | Action |
|---|---|
| `Tab` (in caster) | cycle send target |
| `⌘/Ctrl+Enter` | broadcast to all panes |
| `Alt+1..4` | focus pane 1–4 |
| `Esc` | collapse caster / cancel dialog |

Everything else (including `Shift+Enter`, steering, aborts…) is handled by each agent's own TUI.

## How it works

```
Browser (xterm.js ×4, caster, theming, i18n)
   │  WebSocket (JSON: spawn / input / resize / replay)
   ▼
Node server (server.mjs)
   │  node-pty  ── one PTY per pane
   ▼
pi / claude / codex / $SHELL  — full TUI agents in their own cwd
```

- Static assets are served straight from `node_modules` (xterm.js) — no bundler.
- Each pane keeps a ring buffer so reconnects replay recent output.
- Broadcast = writing `text + \r` to every running PTY; agents receive it like typed input.

## Privacy

- Nothing leaves your machine. The server binds to `127.0.0.1` and makes no outbound requests.
- **No paths are baked into the repo.** The "recent directories" picker reads pi's local session library (`~/.pi/agent/sessions`) on *your* machine at runtime — everyone who clones sees only their own history.
- Don't want that? Run with `AG_RECENTS=0` to disable the scan entirely.

## Security

No authentication, by design — a local tool. Do **not** expose it to a network (`AG_HOST=0.0.0.0` is a foot-gun: anyone on your LAN gets a shell).

## Test

```bash
node server.mjs &        # start server first
npm run test:e2e         # protocol-level E2E: shell echo round-trip + pi TUI boot
```

## License

[MIT](LICENSE)
