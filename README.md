# Claude Sessions

An [Obsidian](https://obsidian.md/) plugin for viewing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Browse, search, analyze, and export your Claude Code sessions as interactive timelines with live watch and rich tool rendering — right alongside your notes.

**Local-first and private.** Claude Sessions reads your JSONL session files directly from disk — no uploads, no syncing, no external services. Your conversations stay on your machine.

> [!IMPORTANT]
> **v0.2.6** — Desktop-only. Active development; expect frequent changes.

<!-- ![Claude Sessions — dark mode](screenshots/hero-dark.png) -->

---

## Features

### Session Timeline

- All turns rendered in a scrollable timeline — no pagination, no lazy loading
- Collapsible turn headers with role labels (USER / CLAUDE) and colored left borders
- Progress bar with per-turn dots positioned by real timestamps
- Content filter menu: hierarchical toggles for User (text, images) and Assistant (text, thinking, tool calls, tool results)

### Tool Rendering

Every tool type gets purpose-built rendering:

- **Bash** — syntax-highlighted code block with command description; diff detection for unified diff output
- **Edit** — red/green diff view (success messages hidden; errors shown)
- **Write** — syntax-highlighted code with language detection from file extension
- **Read** — language-specific syntax highlighting
- **MCP tools** — displayed as `server / tool_name` instead of raw `mcp__server__tool`
- **Sub-agent sessions** — inline with collapsible prompt, tool groups, and output
- **Tool grouping** — consecutive calls above a configurable threshold (default 4) collapse into a summary bar

- **Orphan detection** — tool calls without results show "in progress" (last turn) or "interrupted" (mid-session)
- Tool result images rendered as clickable thumbnails with full-size modal

### Summary Dashboard

Collapsible panel at the top of each session:

- **Hero cards** — cost, context window, turns, duration, and rate limit utilization (beta, opt-in) with pinnable sticky bar
- **Token chart** — stacked horizontal bar (cache read, cache write, uncached, output)
- **Tool chart** — horizontal bars sorted by invocation count
- **Metadata grid** — project, model, version, branch, start time, duration, working directory
- Session ID and Obsidian URI with copy buttons

### Live Watch

- File watcher auto-reloads the session on JSONL changes
- UI state preserved across re-renders (expanded tools, scroll position, show-more, turn collapse)
- Optional pending tool notification — Obsidian Notice + system notification when a tool call is waiting for permission
- Configurable auto-scroll on update

### Search

Dual-mode search panel in the right sidebar:

- **Cross-session** — keyword search across all JSONL files with progressive results; sort by relevance (BM25) or chronological order
- **In-session** — scoped to the active timeline with DOM highlighting and auto-expand of collapsed sections
- Role filter (all / user / assistant), debounced input, arrow key navigation between results
- Cached cross-session results restored instantly when switching tabs

### Session Browser

- Scans configured directories for JSONL session files
- Cached session index — only new/modified files are re-read
- Empty sessions filtered automatically
- Fuzzy search by project name, path, or session ID

### Export

- **Markdown** — YAML frontmatter + Obsidian callouts
- **HTML** — self-contained, zero-dependency file with embedded CSS (captures your current theme), inline images, and standalone JS for all interactive features

### Theming

- 42 CSS custom properties (`--cs-*`) for colors, spacing, typography, and dimensions
- Create custom themes via [Obsidian CSS snippets](https://help.obsidian.md/Extending+Obsidian/CSS+snippets) — no plugin changes needed
- Included [Claude brand theme](examples/claude-sessions-theme-claude.css) with light/dark variants
- See [THEMING.md](THEMING.md) for the full variable reference

### Deep Linking

Open sessions directly via protocol handler:

```
obsidian://claude-sessions?session=/path/to/session.jsonl&turn=7
```

Paths can use `~` for the home directory, e.g. `obsidian://claude-sessions?session=~/.claude/projects/.../session.jsonl`.

---

## Installation

### BRAT (recommended for beta)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Open BRAT settings → **Add Beta plugin**
3. Enter: `gapmiss/claude-sessions`
4. Enable the plugin under Settings → Community plugins

### Manual

Copy `main.js`, `styles.css`, and `manifest.json` into:

```
<your-vault>/.obsidian/plugins/claude-sessions/
```

Restart Obsidian and enable the plugin under Settings → Community plugins.

### From source

```bash
git clone https://github.com/gapmiss/claude-sessions.git
cd claude-sessions
npm install
npm run build
```

---

## Usage

### Browse sessions

1. Run the **Claude Sessions: Browse sessions** command (`Ctrl/Cmd+P`)
2. The plugin scans your configured session directories for JSONL files
3. Select a session from the fuzzy search modal

### Import a file

Run **Claude Sessions: Import session file** — drag-and-drop a `.jsonl` file, use the file picker, or paste a path.

### Export

With a session open, run **Export session to Markdown** or **Export session to HTML**.

---

## Commands

| Command                    | Description                                      |
| -------------------------- | ------------------------------------------------ |
| Browse sessions            | Open a session from the fuzzy search modal       |
| Search sessions            | Open the cross-session search panel              |
| Search in session          | Search within the active session                 |
| Import session file        | Open a session from file path or drag-and-drop   |
| Export session to Markdown | Export as Markdown with frontmatter              |
| Export session to HTML     | Export as self-contained HTML                    |
| Expand all                 | Expand all collapsed turns                       |
| Collapse all               | Collapse all turns                               |
| Refresh session            | Re-read and re-render the current session        |
| Toggle live watch          | Start/stop watching the session file for changes |

---

## Settings

| Setting                | Default              | Description                                                       |
| ---------------------- | -------------------- | ----------------------------------------------------------------- |
| Session directories    | `~/.claude/projects` | Directories to scan for JSONL files (supports `~`)                |
| Export folder          | `Claude sessions`    | Vault folder for exported files                                   |
| Show thinking blocks   | On                   | Display thinking/reasoning blocks                                 |
| Show tool calls        | On                   | Display tool use blocks                                           |
| Show tool results      | On                   | Display tool result output                                        |
| Tool group threshold   | 4                    | Consecutive tool calls above this collapse into a group           |
| Auto-scroll on update  | On                   | Scroll to bottom on live watch changes                            |
| Notify on pending tool | Off                  | System notification when a tool call awaits permission            |
| Show rate limits       | Off                  | Display Claude account rate limit utilization (5-hour and weekly) |

---

## How it works

The Claude Code JSONL format stores each content block (text, thinking, tool_use) as a separate record. The parser:

1. **Merges** consecutive assistant records into single logical turns
2. **Deduplicates** streaming records by UUID (keeps the most complete version)
3. **Attaches** tool results from user records to the preceding assistant turn
4. **Extracts** token usage, deduplicated by message ID, then summed into session stats
5. **Resolves** sub-agent sessions from `subagents/agent-<id>.jsonl` files
6. **Skips** encrypted thinking blocks (Claude Code v2.1.79+) and non-content record types

The timeline view renders all turns immediately into a scrollable container. An `IntersectionObserver` drives scroll-based opacity. Tool-specific renderers handle Bash, Edit, Write, and Read with syntax highlighting and diff views.

---

## Development

```bash
npm install
npm run dev          # watch mode with source maps
npm run build        # typecheck + production bundle
npm test             # 121 tests (vitest)
npm run test:watch   # watch mode tests
npx eslint .         # lint with eslint-plugin-obsidianmd
```

### Tech stack

- TypeScript 5.8 / esbuild
- [diff](https://www.npmjs.com/package/diff) for Edit tool rendering
- [eslint-plugin-obsidianmd](https://www.npmjs.com/package/eslint-plugin-obsidianmd) for Obsidian-specific linting
- Vitest for testing
- Obsidian API (desktop only — requires Node.js `fs` access)

---

## License

[MIT](LICENSE) — Copyright (c) 2026 [@gapmiss](https://github.com/gapmiss)
