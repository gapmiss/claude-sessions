# Architecture

How the plugin is put together: parsing, rendering, export, and distill. It isn't loaded into Claude's context automatically. Reference it with `@ARCHITECTURE.md` when you need it.

## JSONL parser (`parsers/`)

### Record types

| Type | Handling |
| --- | --- |
| `user` | String content becomes a user turn. Array content holds tool results, which attach to the preceding assistant turn |
| `assistant` | Each content block (thinking, text, tool_use) is a **separate record** with its own uuid. Consecutive records merge into one turn |
| `attachment` | Subtypes carry hooks, skills, output style, command permissions, task reminders, mid-turn messages, and more. See `buildTurns()` and `REVIEWED_ATTACHMENT_TYPES` |
| `system` | `compact_boundary` supplies compaction stats. `local_command` becomes a slash command display. `stop_hook_summary` records Stop hook runs. Others are ignored |
| `summary` | Compaction boundary marker |
| `custom-title` | The session title from `/rename` (`customTitle` field). The last one wins |
| `permission-mode` | Becomes a system event when the mode changes, tagged with the turn it applies from |
| `progress` | Skipped, except `agent_progress`, which feeds legacy inline sub-agents |
| `queue-operation` | Skipped, except `<task-notification>` XML, which carries background agent results |
| Metadata-only types | In `SKIP_RECORD_TYPES` (`file-history-snapshot`, `mode`, `ai-title`, `pr-link`, and others) or `REVIEWED_RECORD_TYPES`. Anything unlisted raises a parse warning |

### Parser pipeline (`claude-parser.ts`)

**First pass**, over every line:

1. Parse JSON and pull out metadata (sessionId, cwd, version, branch, model, start time)
2. Track token usage per message ID, keeping the max of each field across streamed duplicates
3. Capture compaction stats from `compact_boundary` records
4. Capture the custom title from `custom-title` records
5. Capture enriched tool results from the `toolUseResult` field
6. Capture `agent_progress` records and `<task-notification>` XML before those record types are skipped
7. Filter out `SKIP_RECORD_TYPES`, sidechain records (unless `allowSidechain`), non-user `isMeta` records, and synthetic-model records
8. Deduplicate by uuid, keeping the last and most complete copy

**Second pass**, in `buildTurns()`:

1. Merge consecutive assistant records into one turn
2. Attach `tool_result` blocks to the preceding assistant turn instead of starting a user turn
3. Handle slash commands. `<command-message>` marks a skill command (sets `_pendingSlashCommand`); `<command-name>` alone is a built-in
4. Keep `isMeta` user records that follow a skill command as a `SlashCommandBlock` (the expanded prompt)
5. Collapse `/exit` into a single "*Session ended*" message
6. Append interruption messages to the assistant turn
7. Pair user bash commands (`<bash-input>`) with their `<bash-stdout>` and `<bash-stderr>`
8. Render compaction boundaries (`isCompactSummary`, `summary` records)
9. Turn attachment records into system events or inline blocks (for example `queued_command` becomes a mid-turn user message), and count unknown subtypes

**Post-processing**:

1. Build `hookEventsByToolId` from hook events whose id names a real tool call
2. Build legacy sub-agent sessions from `agent_progress` records with `buildSubAgentSession()`
3. Attach task-notification results to background agent blocks
4. Attach enriched results. Mark tool calls without results as pending (last turn) or orphaned (earlier)
5. Compute stats: tokens, cost, tool counts, active duration, compactions
6. Report unknown record, block, and attachment types as parse warnings

### Parser state

`buildTurns()` keeps some state on the instance:

- `pendingCommand`: a command whose stdout should be captured
- `_pendingCommandResult`: the next user blocks merge into the preceding slash command turn
- `_pendingSlashCommand`: waiting for the `isMeta` skill expansion record
- `_pendingBashCommand`: waiting for stdout or stderr of a command the user typed

`buildSubAgentSession()` saves all four before parsing a sub-agent and restores them afterwards.

### Sub-agents

- **Foreground**: `agent_progress` records (legacy) stream tool_use and tool_result blocks tagged with `parentToolUseID`, but not text. Text has to come from `<session>/subagents/agent-<id>.jsonl`
- **Background**: no `agent_progress` at all. Completion arrives as `<task-notification>` XML, and the transcript is in the sub-agent JSONL
- Every record in a sub-agent JSONL has `isSidechain: true`, so the parser runs with `allowSidechain: true`
- `resolveSubAgentSessions()` in `claude-subagent.ts` does the loading. The timeline view calls it after parsing. `parseSessionFile()` in the public API does not

### Cost

`getPricing()` picks per-million-token rates by model family (opus, fable, haiku, and sonnet as the default) from a substring of the model ID. `estimateCost()` bills cache writes at the 5-minute or 1-hour rate using the `ephemeral_1h_input_tokens` breakdown when it's there.

## Rendering (`views/`)

### Timeline view (`timeline-view.ts`)

An `ItemView` of type `claude-sessions-timeline`.

- **Scroll dimming**: an `IntersectionObserver` gives turns in view the `visible` class (full opacity). Others dim to 0.3
- **UI state**: `captureUIState()` and `restoreUIState()` keep collapsed turns, expanded tools, groups, and text, the summary panel, and scroll position across re-renders. State is keyed by turn and block index, which stays stable because the JSONL only grows
- **Filters**: `FilterState` has 8 toggles, two parents (user, assistant) and six children (user text and images; assistant text, thinking, tool calls, tool results). Filtered elements get `claude-sessions-filtered`
- **Live watch**: `fs.watch()`, falling back to `fs.watchFile()`, with a 1500ms debounce. Reloads the session and restores UI state
- **Pending tool notification**: deduplicated by `lastNotifiedToolId`. Shows an Obsidian Notice and a system notification
- **Search highlight**: a TreeWalker finds the text, splits the node, and wraps the match in `<mark>`. It expands any collapsed ancestor: tool blocks, tool groups, thinking, show-more, slash commands, compaction summaries, and Markdown preview toggles. `matchContext` picks the right occurrence when a turn has several

### Timeline renderer (`timeline-renderer.ts`)

- `renderTimeline()`: summary panel, then every turn
- `renderTurn()`: header (role, turn number, timestamp, model, stop reason) and body
- `renderAssistantBlocks()`: splits runs of tool calls from single blocks and wraps each
- `renderTextContent()`: Markdown with a "show more" collapse past 10 lines, and a copy button
- `renderThinkingBlock()`: faded, collapsible, with a copy button
- `buildAnsiDom()`: ANSI escapes to DOM (4-bit and 24-bit color, bold, dim, italic, underline)
- Compaction dividers and mid-turn user messages
- Mermaid: a MutationObserver finds rendered diagrams and wraps them with a click-to-expand modal. SVG IDs are remapped so the copy doesn't inherit the original's styles

### Tool renderer (`tool-renderer.ts`)

- `renderToolGroup()`: collapses consecutive tool calls past the threshold
- `renderToolCall()`: a compact header (indicator, name, preview, duration, hook icons, chevron) over an expandable body
- Per-tool renderers: `renderBashInput()`, `renderDiffView()` for Edit, `renderWriteView()`, `renderWebFetchInput()`, Read with language highlighting, and a code/preview toggle (`renderMarkdownToggle()`) for Markdown files and WebFetch results
- Bash results: unified diffs render as diffs, ANSI output keeps its colors, and a non-zero exit code shows with stderr
- Task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`): a cumulative checklist, tracked across the session
- `renderSubAgentSession()`: collapsible PROMPT, the sub-agent's blocks, then OUTPUT
- `renderAskUserQuestion()`: questions and answers. `renderAskPreview()` shows each option's `preview` as a collapsible preformatted block, opened for the selected option
- `toolPreview()`: the one-line preview for each tool's header
- `parseMcpToolName()`: splits `mcp__server__tool`
- Inline indicators from `hookEventsByToolId`: zap (PreToolUse), shield (permission decision), scissors (Read truncated), octagon and triangle (blocking and non-blocking hook errors)

### System events renderer (`system-events-renderer.ts`)

- A collapsible "System events" panel below the summary
- Sections: output style, permission mode, command permissions, hooks, available skills, task reminders
- Stop hooks are grouped by command (`summarizeStopHooks()`): runs, average duration, errors, and blocked stops. One row per run would mean hundreds of identical rows
- Hook events tied to a tool call are left out here, because they show on the tool call
- Header counts add up the *items* in listing records (`skillCount`, `itemCount`), not the number of records

### Summary renderer (`summary-renderer.ts`)

- A pinnable sticky bar of hero cards (pin state is per session) and the collapsible summary panel
- Hero cards: cost, context, turns, duration, and rate limits when that beta setting is on
- `refreshSummary()` saves and restores pin and open state across live reloads
- Token chart: stacked input bar (cache read, cache write, uncached) and an output bar
- Tool chart: horizontal bars by call count
- Details grid: project, model, version, branch, start time, duration, cwd
- Parse warnings, with a hint to check for plugin updates
- Session ID, resume command, and URI rows with copy buttons

### Search view (`search-view.ts`)

- An `ItemView` in the right sidebar, type `claude-sessions-search`
- All sessions: `searchSessions()` and `searchSessionsRanked()` stream results, grouped by session
- This session: `searchFile()` and `searchFileRanked()` over the open timeline, highlighted with `navigateToMatch()`
- Matches come from exact substring search. BM25 only decides the order in relevance mode
- `resolveMatchTurn()` maps a cross-session match to its real turn by timestamp and passes `matchContext` along for highlighting
- Role filter, relevance or date sort, debounced input, cancellation with `AbortController`, arrow-key navigation
- Cached cross-session results come back when you return to the tab with the same query, role, and sort
- State persists through `getState()` and `setState()`

## Distill (`distill/`)

Turns a parsed session into an Obsidian note with queryable frontmatter. There's no LLM call; everything comes from the session's structure (called Layer 0 in the code).

### Steps (`distill-session.ts`)

1. **Extract** (`extract-frontmatter.ts`): id, project, cwd, branch, model, start time, duration, tokens, cost, tool counts, files touched, error count
2. **Find** (`find-existing.ts`): look in the distill folder for a note with the same `session_id`
3. **Build** (`build-note.ts`): frontmatter plus a Stats table. Notes are named `{project}--{YYYY-MM-DD}--{short-id}.md`
4. **Merge**: if the existing note has a `## Summary` (it came from `/distill`), keep its body and refresh the frontmatter. Otherwise replace the note
5. **Write** to `distillFolder`

### Frontmatter fields (`types.ts`)

- Identity: `session_id`, `schema_version` (1)
- Context: `project`, `cwd`, `branch`, `model`, `title`
- Timing: `start_time`, `duration_min`
- Cost: `cost_usd`, `context_tokens`, `input_tokens`, `output_tokens`, `cache_read_tokens`
- Shape: `user_turns`, `assistant_turns`, `tools_used[]`, `files_touched[]`
- Errors: `error_count`
- Classification: `session_type[]`, filled in only by the `/distill` skill
- Links back: `source_path`, `obsidian_uri`

### Bases templates (`bases-templates.ts`)

Four `.base` dashboards for distilled notes: Session Dashboard (every session with totals), Cost Tracker (by project), Recent Sessions (last 7 days), and Error Patterns (sessions with errors). Installed by the `install-bases-templates` command.

### Clipboard merge

1. `/distill` runs in Claude Code and prints a note
2. The user copies it
3. With the same session open, **Merge /distill output from clipboard** combines the skill's narrative with exact frontmatter. Numbers come from the plugin; `session_type` and the narrative come from the skill; `files_touched` and `tags` are merged

## Public API (`api.ts`)

```typescript
const api = app.plugins.plugins['claude-sessions']?.api as ClaudeSessionsAPI;
```

- `getActiveSession()`: the Session in the active timeline view
- `parseSessionFile(path)`: parse a JSONL file. Sub-agents are not resolved
- `onSessionParsed(callback)`: called on every load and live reload. Returns an unsubscribe function
- `getSessionIndex()`: every indexed `SessionListEntry`

The timeline view calls `emitSessionParsed()` on load and reload.

## Export (`exporters/`)

Both exports open an options modal (`export-modal.ts`) first:

- **Include summary**: stats, token and tool usage, details (`exportIncludeSummary`)
- **Include system events**: hooks, skills, and the rest of the panel (`exportIncludeSystemEvents`)

The choices persist in plugin settings.

### HTML

A snapshot of the timeline as already rendered:

1. **`css-capture.ts`** collects CSS at export time:
   - `captureThemeVariables()`: every `--*` property, resolved with `getComputedStyle()`
   - `captureMarkdownStyles()`: the `app.css` rules for Markdown, PrismJS, and SVG
   - `capturePluginStyles()`: the plugin's stylesheet, found by `claude-sessions` in its first rule
   - `captureFontFaces()`: embedded (`data:`) fonts
2. **`standalone-player.ts`** is the script in the exported file:
   - Delegated handlers for collapsibles, copy, show-more, image and mermaid modals, filters, and Markdown toggles
   - Collapsibles toggle `open` and `collapsed`, the same as the live view
   - Copy falls back to `document.execCommand('copy')` under `file://`
3. **`html-exporter.ts`** puts it together:
   - `snapshotTimeline()` deep-clones the timeline, adds `visible`, and moves copy text into `data-copy-text`
   - Removes the pinned hero bar, which only works live
   - Removes the summary and system events panels if the options say so
   - Saves with Electron's `remote.dialog.showSaveDialog()`, or next to the session file if that isn't available

### Markdown (`markdown-exporter.ts`)

Built from the parsed `Session`, not the DOM:

- **Frontmatter**: cost, tokens (input, output, cache read and write, total, context, peak), compaction count, duration
- **Summary** (optional): hero stats, token and tool tables, details, parse warnings
- **System events** (optional): output style; permission mode; command permissions; hooks with event, duration, command, and exit code, plus grouped Stop hooks; skills; task reminders
- **Tools**: Edit as a diff, Write highlighted, Bash as a command block, Read as path and line range, AskUserQuestion as questions and answers with option previews, Agent and Task as nested turns, ToolSearch as a list of matches
- **Enriched results**: Bash stderr and exit code, AskUserQuestion answers, ToolSearch matches, permission decisions
- **Turn headings** flag API errors and max-token stops

## CSS classes

- Outer containers: `claude-sessions-summary-*` (panel, header, chevron, copy buttons)
- Dashboard contents: `claude-sessions-dash-*` (hero cards, charts, details, IDs)
- Tool blocks: `claude-sessions-tool-*` (block, header, body, indicator, name, preview, hook indicators)
- System events: `claude-sessions-system-events-*`
- Filtering: `claude-sessions-filtered` sets `display: none`
- State: `open` (tools, thinking, summary, sub-agents, slash commands, compaction, system events), `collapsed` (turns), `is-collapsed` (show-more), `visible` (in view), `is-pinned` (hero bar), `claude-sessions-read-md-hidden` (Markdown toggle)

## Commands

| ID | Name |
| --- | --- |
| `browse-sessions` | Browse sessions |
| `search-sessions` | Search sessions |
| `import-file` | Import session file |
| `export-markdown` | Export session to Markdown |
| `export-html` | Export session to HTML |
| `expand-all` | Expand all turns |
| `collapse-all` | Collapse all turns |
| `expand-all-blocks` | Expand all blocks (tools, thinking, summary) |
| `collapse-all-blocks` | Collapse all blocks (tools, thinking, summary) |
| `refresh-session` | Refresh session |
| `toggle-live-watch` | Toggle live watch |
| `search-in-session` | Search in session |
| `copy-resume` | Copy resume to clipboard |
| `distill-session` | Distill session to note |
| `merge-distill-clipboard` | Merge /distill output from clipboard |
| `install-bases-templates` | Install bases dashboard templates |

## Security

- The renderer never uses `innerHTML`. Everything is built with `createEl`, `createSpan`, and `appendText`
- Image copy to clipboard only allows MIME types in `SAFE_IMAGE_TYPES`
- Dropped filenames go through `path.basename()` so they can't traverse paths
- `escapeHtml()` escapes metadata in the HTML export header
- The protocol handler only opens local files
- The save dialog uses Electron's deprecated `remote` API. Watch for Obsidian dropping it
- ANSI inline styles only ever contain numeric RGB values parsed from escape codes
