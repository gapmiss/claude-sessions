# Claude Sessions

An [Obsidian](https://obsidian.md/) plugin for viewing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Browse, search, analyze, and export your Claude Code sessions as interactive timelines with live watch and rich tool rendering — right alongside your notes.

**Local-first and private.** Claude Sessions reads your JSONL session files directly from disk — no uploads, no syncing, no external services. Your conversations stay on your machine.

> [!IMPORTANT]
> **v0.2.14** — Desktop-only. Active development; expect frequent changes.

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
- **AskUserQuestion** — header badges, option cards with selected/rejected state, answer summary, copy raw JSON
- **ToolSearch** — matched tool names with icons and deferred tool count
- **MCP tools** — displayed as `server / tool_name` instead of raw `mcp__server__tool`
- **Sub-agent sessions** — inline with collapsible prompt, tool groups, and output (supports both legacy inline and separate JSONL file formats)
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

### Session Distillation

Convert sessions into structured Obsidian notes with queryable frontmatter — zero LLM cost (Layer 0 extraction).

- **Distill to note** — extracts session metadata into YAML frontmatter: project, cost, tokens, duration, tools used, files touched, error count
- **Clipboard merge** — combine LLM-generated summaries (using the [`/distill`](./skills/distill/SKILL.md) skill) with exact session stats
- **Obsidian Bases dashboards** — pre-built `.base` templates for aggregate views:
  - Session Dashboard — all sessions with cost/tokens/duration summaries
  - Cost Tracker — grouped by project
  - Recent Sessions — last 7 days
  - Error Patterns — sessions with errors

Distilled notes are ideal for:
- Querying sessions with Dataview or Bases
- Tracking costs and token usage over time
- Finding sessions by project, date, or error count
- Building personal knowledge bases from Claude conversations

#### `/distill` Workflow

Since `/distill` runs in Claude Code (not Obsidian), it outputs to stdout with a placeholder `session_id`. To get accurate metadata merged with your narrative:

1. Run `/distill` at the end of your session
2. **Copy the output** to clipboard
3. Open the same session in the Obsidian plugin timeline view
4. Run command: **"Merge /distill output from clipboard"**

The plugin will:
- Use the real `session_id` from the active session
- Replace approximate token/cost values with exact parsed values
- Preserve your Summary, Decisions, Learnings, Key Exchanges sections
- Merge `files_touched` and `tags` arrays from both sources

#### Installation

To install this skill globally for all projects:

```bash
cp -r .claude/skills/distill ~/.claude/skills/
```

Then run `/distill` at the end of any Claude Code session.

### System Events

Collapsible panel showing session-level context:

- **Hooks** — PreToolUse, PostToolUse, PermissionRequest events with duration and exit codes
- **Available skills** — slash commands available during the session
- **Task reminders** — background task counts

Inline indicators on tool calls: zap icon for PreToolUse hooks, shield icon for PermissionRequest.

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

### Distill a session

1. Open a session in the timeline view
2. Run **Claude Sessions: Distill session to note**
3. A structured note is created in your distill folder with:
   - YAML frontmatter (project, cost, tokens, duration, tools, files, errors)
   - Placeholder sections for Summary, Key Changes, Learnings, Related

**To add LLM-generated summaries:**

1. In Claude Code, run [`/distill`](./skills/distill/SKILL.md) on your session
2. Copy the output to clipboard
3. In Obsidian, open the same session
4. Run **Claude Sessions: Merge /distill output from clipboard**
5. The plugin merges the LLM narrative with exact session stats

### Set up Bases dashboards

1. Run **Claude Sessions: Install bases dashboard templates**
2. Templates are created in your bases folder
3. Open a `.base` file to see aggregate session data (requires Obsidian 1.8+ with Bases enabled)

---

## Commands

| Command                                                             | Description                                        |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Browse sessions                                                     | Open a session from the fuzzy search modal         |
| Search sessions                                                     | Open the cross-session search panel                |
| Search in session                                                   | Search within the active session                   |
| Import session file                                                 | Open a session from file path or drag-and-drop     |
| Export session to Markdown                                          | Export as Markdown with frontmatter                |
| Export session to HTML                                              | Export as self-contained HTML                      |
| Expand all turns                                                    | Expand all collapsed turns                         |
| Collapse all turns                                                  | Collapse all turns                                 |
| Expand all blocks                                                   | Expand all tools, thinking blocks, and summary     |
| Collapse all blocks                                                 | Collapse all tools, thinking blocks, and summary   |
| Refresh session                                                     | Re-read and re-render the current session          |
| Toggle live watch                                                   | Start/stop watching the session file for changes   |
| Copy resume to clipboard                                            | Copy `claude --resume <id>` command                |
| Distill session to note                                             | Create/update a structured note with session stats |
| Merge [`/distill`](./skills/distill/SKILL.md) output from clipboard | Combine LLM summary with Layer 0 frontmatter       |
| Install bases dashboard templates                                   | Add Obsidian Bases templates to your vault         |

---

## Settings

| Setting                | Default                     | Description                                                       |
| ---------------------- | --------------------------- | ----------------------------------------------------------------- |
| Session directories    | `~/.claude/projects`        | Directories to scan for JSONL files (supports `~`)                |
| Export folder          | `Claude sessions`           | Vault folder for exported files                                   |
| Distill folder         | `Claude sessions/distilled` | Vault folder for distilled session notes                          |
| Bases folder           | `Claude sessions/bases`     | Vault folder for Obsidian Bases dashboard templates               |
| Show thinking blocks   | On                          | Display thinking/reasoning blocks                                 |
| Show tool calls        | On                          | Display tool use blocks                                           |
| Show tool results      | On                          | Display tool result output                                        |
| Content width          | 960px                       | Maximum width of session content (presets: 680–1200px or full)    |
| Tool group threshold   | 4                           | Consecutive tool calls above this collapse into a group           |
| Auto-scroll on update  | On                          | Scroll to bottom on live watch changes                            |
| Notify on pending tool | Off                         | System notification when a tool call awaits permission            |
| Show rate limits       | Off                         | Display Claude account rate limit utilization (5-hour and weekly) |

---

## How it works

The Claude Code JSONL format stores each content block (text, thinking, tool_use) as a separate record. The parser:

1. **Merges** consecutive assistant records into single logical turns
2. **Deduplicates** streaming records by UUID (keeps the most complete version)
3. **Attaches** tool results from user records to the preceding assistant turn
4. **Extracts** token usage, deduplicated by message ID, then summed into session stats
5. **Resolves** sub-agent sessions from `subagents/agent-<id>.jsonl` files
6. **Captures** system events (hooks, skills, task reminders) and custom session titles
7. **Skips** encrypted thinking blocks (Claude Code v2.1.79+) and non-content record types

The timeline view renders all turns immediately into a scrollable container. An `IntersectionObserver` drives scroll-based opacity. Tool-specific renderers handle Bash, Edit, Write, Read, AskUserQuestion, and ToolSearch with syntax highlighting, diff views, and structured displays.

---

## Public API

Other plugins can access session data via the public API:

```typescript
const api = app.plugins.plugins['claude-sessions']?.api as ClaudeSessionsAPI;

// Get the active session
const session = api.getActiveSession();

// Parse a JSONL file
const session = await api.parseSessionFile('/path/to/session.jsonl');

// Subscribe to session load/reload events
const unsubscribe = api.onSessionParsed((session) => {
  console.log('Session loaded:', session.metadata.project);
});

// Get all indexed sessions (lightweight metadata)
const entries = await api.getSessionIndex();
```

---

## Development

```bash
npm install
npm run dev          # watch mode with source maps
npm run build        # typecheck + production bundle
npm test             # vitest
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
