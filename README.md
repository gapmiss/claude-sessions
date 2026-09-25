# Claude Sessions

An [Obsidian](https://obsidian.md/) plugin for reading your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Browse, search, and export them as interactive timelines, with live watch and proper rendering for each tool, right next to your notes.

**Local and private.** The plugin reads Claude Code's JSONL files straight from disk. Nothing is uploaded or synced, and your conversations stay on your machine. The one exception is the optional rate limit display, covered under [Security notices](#security-notices).

> [!IMPORTANT]
> **v0.3.26**. Desktop only.

> [!NOTE]
> **System identity access:** the plugin reads the `HOME` environment variable and `os.homedir()` to find Claude Code's session files in `~/.claude/projects/`, and the OAuth credentials used by the rate limit display. These values only build local file paths. Nothing is sent anywhere.

---

## Installation

[Install from community.obsidian.md](https://community.obsidian.md/plugins/claude-sessions), or from inside Obsidian:

1. Open **Settings > Community plugins > Browse**
2. Search for "Claude Sessions" and install it

To install manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gapmiss/claude-sessions/releases/latest)
2. Put them in a new folder at `/path/to/vault/.obsidian/plugins/claude-sessions`
3. In **Settings > Community plugins**, reload **Installed plugins** and enable Claude Sessions

---

## Features

### Session timeline

- Every turn in one scrollable timeline, with no pagination
- Collapsible turns labeled USER or CLAUDE, with a colored left border for each role
- A progress bar with one dot per turn, placed by its real timestamp
- A filter menu to show or hide user text and images, assistant text, thinking, tool calls, and tool results
- Context compactions appear as dividers you can expand to read the summary
- Messages you sent while Claude was working show up where they interrupted

### Tool rendering

Common tools get their own layout instead of raw JSON:

- **Bash**: the command with its description, highlighted. Output keeps its ANSI colors, unified diffs render as diffs, and failures show the exit code and stderr
- **Edit**: a red and green diff
- **Write**: the file content, highlighted by file extension
- **Read**: highlighted by language. Markdown files get a code/preview toggle
- **WebFetch**: a clickable URL and the prompt, with the result in a code/preview toggle
- **TaskCreate, TaskUpdate, TaskList, TaskGet**: a running checklist of tasks and their status
- **AskUserQuestion**: each question with its options, which one was picked, any free-text answer, and option previews
- **ToolSearch**: the matched tools and how many were deferred
- **MCP tools**: shown as `server / tool_name` rather than `mcp__server__tool`
- **Sub-agents**: rendered inline with their prompt, tool calls, and output. Both the old inline format and the newer separate JSONL files work

Every tool shows a one-line preview in its collapsed header. Runs of consecutive tool calls longer than a set threshold (4 by default) collapse into a single group. A tool call with no result is marked "in progress" on the last turn and "interrupted" anywhere else. Images in tool results appear as thumbnails that open full size.

### Summary dashboard

A collapsible panel at the top of each session:

- **Hero cards**: cost, context size, turns, and active duration. With the beta rate limit setting on, it also shows your 5-hour and 7-day usage. You can pin the cards as a sticky bar
- **Token usage**: a stacked bar for cache reads, cache writes, and uncached input, plus output
- **Tool usage**: calls per tool, most used first
- **Session details**: project, model, Claude Code version, branch, start time, duration, and working directory
- The session ID and an Obsidian link to the session, each with a copy button

### Live watch

- Reloads the session whenever its JSONL file changes
- Keeps your place: expanded tools, collapsed turns, "show more" sections, and scroll position all survive the reload
- Can scroll to the newest content automatically
- Can notify you (in Obsidian and as a system notification) when a tool call is waiting for your permission

### Search

A search panel in the right sidebar with two modes:

- **All sessions**: searches every JSONL file, streaming results in as they're found. Sort by relevance (BM25) or by date
- **This session**: searches the open timeline, highlights the match, and expands whatever was hiding it
- Filter by role (all, user, or assistant) and move between results with the arrow keys
- Your last cross-session results come back instantly when you switch tabs

### Session browser

- Finds JSONL files in the directories you configure
- Keeps an index on disk, so only new or changed files get read again
- Leaves out empty sessions
- Fuzzy search by project name, path, or session ID
- Pin sessions to keep them at the top of the list

### Export

- **Markdown**: YAML frontmatter with the session's stats, and Obsidian callouts for the conversation
- **HTML**: one self-contained file with your current theme's CSS, images, and the interactive features built in. It opens in any browser

Before each export you can choose whether to include the summary dashboard and the system events panel. The plugin remembers your choice.

### Session distillation

Turn a session into an Obsidian note with frontmatter you can query. This step doesn't call any LLM.

- **Distill session to note**: writes the session's project, cost, tokens, duration, tools, files touched, and error count into YAML frontmatter, followed by a short stats table
- **Merge from clipboard**: combines a summary written by the [`/distill`](./skills/distill/SKILL.md) skill with the plugin's exact numbers
- **Bases dashboards**: four ready-made `.base` views of your distilled notes:
  - Session Dashboard: every session, with cost, token, and duration totals
  - Cost Tracker: cost grouped by project
  - Recent Sessions: the last 7 days
  - Error Patterns: sessions that hit errors

Use distilled notes to track spending over time, find past sessions by project, date, or errors, or build up notes from your Claude work with Bases or Dataview.

#### The `/distill` skill

`/distill` runs inside Claude Code, not Obsidian. It writes the summary, decisions, and learnings from the conversation, but it can only estimate the numbers. The plugin has the exact ones. To combine them:

1. Run `/distill` at the end of a Claude Code session
2. Copy its output
3. Open the same session in Obsidian
4. Run **Merge /distill output from clipboard**

The plugin fills in the real `session_id`, replaces the estimated token and cost figures with exact ones, keeps the skill's narrative sections, and merges the `files_touched` and `tags` lists from both sources.

Running **Distill session to note** again later refreshes the numbers in a merged note and leaves its text alone.

To install the skill for all your projects, copy it from this repository:

```bash
cp -r skills/distill ~/.claude/skills/
```

### System events

A collapsible panel for things that happened around the conversation rather than in it:

- **Hooks**: PreToolUse, PostToolUse, PermissionRequest, and others, with duration and exit code. Stop hooks, which run after every turn, get one row per hook with its run count, average time, and any errors
- **Available skills**: the slash commands the session could use
- **Output style**: the active output style
- **Permission mode**: each mode the session used (default, acceptEdits, plan, auto) and the turn it started
- **Command permissions**: tools a slash command pre-approved through its `allowed-tools` frontmatter
- **Task reminders**: background task counts

Some events belong to a specific tool call, and those show as icons on the call itself: a zap for a PreToolUse hook, a shield for a permission decision (green if allowed, red if denied), scissors when a Read result was truncated, and a red or yellow warning when a hook failed.

### Theming

- 45 CSS variables (`--cs-*`) for colors, spacing, type, and sizes
- Override them with an [Obsidian CSS snippet](https://help.obsidian.md/Extending+Obsidian/CSS+snippets). No plugin changes needed
- Includes a [Claude brand theme](examples/claude-sessions-theme-claude.css) with light and dark variants
- [THEMING.md](THEMING.md) lists every variable

### Deep links

Open a session, optionally at a specific turn, with a link:

```
obsidian://claude-sessions?session=/path/to/session.jsonl&turn=7
```

Paths can start with `~`, for example `obsidian://claude-sessions?session=~/.claude/projects/.../session.jsonl`.

---

## Usage

### Open a session

Run **Claude Sessions: Browse sessions** from the command palette (`Ctrl/Cmd+P`) and pick a session.

To open a file from somewhere else, run **Claude Sessions: Import session file**, then drop a `.jsonl` file, choose one, or paste its path.

### Export

With a session open, run **Export session to Markdown** or **Export session to HTML**.

### Distill a session

1. Open a session
2. Run **Claude Sessions: Distill session to note**
3. The note appears in your distill folder

To add a written summary, see [the `/distill` skill](#the-distill-skill).

### Set up Bases dashboards

1. Run **Claude Sessions: Install bases dashboard templates**
2. Open any of the `.base` files it creates in your bases folder. This needs the Bases core plugin enabled

---

## Commands

| Command | What it does |
| --- | --- |
| Browse sessions | Pick a session from a searchable list |
| Search sessions | Open the search panel across all sessions |
| Search in session | Search the open session |
| Import session file | Open a session from a path or by drag-and-drop |
| Export session to Markdown | Export as Markdown with frontmatter |
| Export session to HTML | Export as a self-contained HTML file |
| Expand all turns | Expand every turn |
| Collapse all turns | Collapse every turn |
| Expand all blocks (tools, thinking, summary) | Expand every tool, thinking block, and the summary |
| Collapse all blocks (tools, thinking, summary) | Collapse them again |
| Refresh session | Re-read and redraw the session |
| Toggle live watch | Start or stop watching the file for changes |
| Copy resume to clipboard | Copy `claude --resume <id>` |
| Distill session to note | Create or update a note with the session's stats |
| Merge [`/distill`](./skills/distill/SKILL.md) output from clipboard | Combine the skill's summary with exact stats |
| Install bases dashboard templates | Add the Bases dashboards to your vault |

---

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Session directories | `~/.claude/projects` | Where to look for JSONL files. `~` works |
| Export folder | `Claude sessions` | Where exports are saved |
| Distill folder | `Claude sessions/distilled` | Where distilled notes are saved |
| Bases folder | `Claude sessions/bases` | Where the Bases dashboards are saved |
| Show thinking blocks | On | Show Claude's thinking |
| Show tool calls | On | Show tool calls |
| Show tool results | On | Show tool output |
| Content width | 960px | Maximum content width: 680, 800, 960, 1200px, or full |
| Tool group threshold | 4 | Longer runs of consecutive tool calls collapse into a group |
| Auto-scroll on update | On | Scroll to the bottom when live watch picks up changes |
| Notify on pending tool | Off | Send a notification when a tool call needs permission |
| Show rate limits (beta) | Off | Show your Claude 5-hour and 7-day usage on the dashboard |
| Debug level | Warnings and errors | How much the plugin logs to the developer console |

---

## How it works

Claude Code writes each piece of an assistant message (text, thinking, a tool call) as its own JSONL record. The parser:

1. **Merges** consecutive assistant records into one turn
2. **Deduplicates** streamed records by uuid, keeping the most complete copy
3. **Attaches** each tool result to the tool call it answers
4. **Totals** token usage, counting each message once
5. **Loads** sub-agent sessions from `subagents/agent-<id>.jsonl`
6. **Collects** system events (hooks, skills, output style, permissions) and custom session titles
7. **Skips** encrypted thinking and records that carry no content

When a newer Claude Code version writes a record type the plugin hasn't seen, the summary panel shows a warning so the gap gets noticed and fixed.

---

## Keep your session history

> [!WARNING]
> By default, Claude Code deletes session files older than **30 days**. If you use this plugin to track costs or keep notes on past work, raise that limit.

In `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 365
}
```

---

## Public API

Other plugins can read session data:

```typescript
const api = app.plugins.plugins['claude-sessions']?.api as ClaudeSessionsAPI;

// The session in the active timeline
const session = api.getActiveSession();

// Parse any JSONL file (sub-agents are not resolved)
const parsed = await api.parseSessionFile('/path/to/session.jsonl');

// Run a callback whenever a session loads or live watch reloads it
const unsubscribe = api.onSessionParsed((session) => {
  console.log('Session loaded:', session.metadata.project);
});

// Lightweight metadata for every indexed session
const entries = await api.getSessionIndex();
```

The API is stable. New methods may be added, and removing one would be a breaking change.

---

## Security notices

[Community scorecard](https://community.obsidian.md/plugins/claude-sessions#scorecard)

The Obsidian community scanner flags two patterns in this plugin. Both are in the rate limit feature (`src/utils/rate-limits.ts`), which is in beta and off by default, and both exist only to read the Claude Code OAuth credential you already have. Nothing is collected, sent to third parties, or used to identify you.

| Warning | Where | Why |
| --- | --- | --- |
| Shell execution (`child_process`) | `execSync` runs the macOS `security` command (line 55) | Reads your Claude OAuth token from the macOS Keychain so the plugin can ask Anthropic for your rate limit usage. Runs only on macOS, and only with "Show rate limits" on |
| System identity and environment variables | `process.env.HOME` (line 49) | Finds `~/.claude/.credentials.json`, where Claude Code keeps the token on Linux. Not used for identification or telemetry |

What it touches:

- One Keychain entry: `"Claude Code-credentials"`
- The token goes only to `api.anthropic.com/api/oauth/usage`, through Obsidian's `requestUrl()`
- Both paths require the desktop app and the "Show rate limits" setting
- Nothing else leaves the plugin

Leave "Show rate limits" off and this code never runs.

---

## Development

```bash
npm install
npm run dev          # watch mode with source maps
npm run build        # typecheck and production bundle
npm test             # vitest
npm run test:watch   # vitest in watch mode
npx eslint .         # lint, including eslint-plugin-obsidianmd
```

Built with TypeScript 5.8 and esbuild, [diff](https://www.npmjs.com/package/diff) for Edit diffs, [eslint-plugin-obsidianmd](https://www.npmjs.com/package/eslint-plugin-obsidianmd) for linting, and Vitest for tests. It uses Node's `fs`, which is why it's desktop only.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.

---

## License

[MIT](LICENSE). Copyright (c) 2026 [@gapmiss](https://github.com/gapmiss)
