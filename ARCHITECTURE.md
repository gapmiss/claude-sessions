# Architecture — Claude Sessions Plugin

Reference document for detailed implementation. Not auto-included — use `@ARCHITECTURE.md` when needed.

## JSONL Parser (`parsers/`)

### Record Types (Claude Code JSONL format)

| Type | Handling |
|---|---|
| `user` | String content → user turn. Array content → tool results attached to preceding assistant turn |
| `assistant` | Each content block (thinking, text, tool_use) is a **separate record** with its own uuid. Consecutive records merge into one Turn |
| `progress` | `hook_progress` → hook events by toolUseID. `agent_progress` → sub-agent blocks. All others skipped |
| `queue-operation` | `<task-notification>` XML captured for background agents. Others skipped |
| `summary` | Compaction boundary marker |
| `system` | `local_command` subtype → slash command display. Others skipped |
| `file-history-snapshot` | Always skipped (non-content) |

### Parser Pipeline (`claude-parser.ts`)

**First pass** — iterate all lines:
1. Parse JSON, extract metadata (sessionId, cwd, version, branch, model, startTime)
2. Capture hook events from `hook_progress` records (before SKIP_TYPES filter)
3. Capture agent progress from `agent_progress` records
4. Track token usage per message ID (keep max of each field across streaming dupes)
5. Capture enriched tool results from `toolUseResult` field
6. Capture `<task-notification>` from queue-operation and user records
7. Filter: skip `SKIP_RECORD_TYPES`, `isSidechain` (unless `allowSidechain`), `isMeta` non-user, synthetic model
8. Deduplicate by uuid — keep last (most complete) version

**Second pass** (`buildTurns()`):
1. Merge consecutive assistant records into single Turn
2. Attach tool_result blocks to preceding assistant turn (not separate user turn)
3. Handle slash commands: `<command-message>` → skill command (set `_pendingSlashCommand`); `<command-name>` without it → built-in
4. Capture isMeta user records as `SlashCommandBlock` when they follow a skill command
5. Consolidate `/exit` → single "*Session ended*" message
6. Handle interruption messages → append to assistant turn
7. Handle user bash commands (`<bash-input>` / `<bash-stdout>`)
8. Handle compaction boundaries (`isCompactSummary`, `summary` records)

**Post-processing:**
1. Attach hook events to ToolUseBlock.hooks[]
2. Build sub-agent sessions from agent_progress records via `buildSubAgentSession()`
3. Attach task-notification results to background agent blocks
4. Attach enriched results, mark orphaned (mid-session) vs pending (last-turn) tool calls
5. Compute stats (tokens, costs, tool counts, duration)
6. Log unknown record/block types for format change detection

### Parser State Fields

The parser uses instance state during `buildTurns()`:
- `pendingCommand` — tracks commands whose stdout should be captured
- `_pendingCommandResult` — next user blocks merge into preceding slash command turn
- `_pendingSlashCommand` — awaiting isMeta skill expansion record
- `_pendingBashCommand` — awaiting bash-stdout/stderr for user-typed command

**Note**: `buildSubAgentSession()` saves/restores `pendingCommand` but not the other three fields. Sub-agents are unlikely to contain slash commands, but this is a latent bug.

### Sub-Agent Resolution

- **Foreground**: `agent_progress` records stream tool_use/tool_result blocks with `parentToolUseID`. Text blocks omitted — must read `<session>/subagents/agent-<id>.jsonl`
- **Background**: No agent_progress at all. Completion arrives as `<task-notification>` XML. Must also read subagent JSONL
- Subagent JSONL marks all records `isSidechain: true` → parser needs `allowSidechain: true`
- Resolution via `resolveSubAgentSessions()` in `claude-subagent.ts`

### Cost Estimation

Per-million-token pricing by model family (opus/sonnet/haiku) in `estimateCost()`. Model detected by substring match on model ID.

## Rendering Pipeline (`views/`)

### Timeline View (`timeline-view.ts`)

Extends `ItemView` with type `claude-sessions-timeline`.

Key systems:
- **IntersectionObserver** — turns in viewport get `visible` class (opacity 1.0), others dim to 0.3
- **UI state preservation** — `captureUIState()`/`restoreUIState()` save collapsed turns, expanded tools/groups/text, summary panel, scroll position across re-renders. Keyed by turn+block index (stable for append-only JSONL)
- **Content filters** — `FilterState` with 8 toggles (user text/images, assistant text/thinking/tool calls/tool results). Applied via CSS class `claude-sessions-filtered`
- **Live watch** — `fs.watch()` with `watchFile()` fallback. 1500ms debounce. Auto-reloads session, preserves UI state
- **Pending tool notification** — deduped by `lastNotifiedToolId`. Obsidian Notice + system Notification
- **Search highlight** — TreeWalker finds text match, splits node, wraps in `<mark>`, auto-expands collapsed ancestors

### Timeline Renderer (`timeline-renderer.ts`)

- `renderTimeline()` → summary panel + all turns
- `renderTurn()` → header (role, turn#, timestamp, model, stop reason) + body (user/assistant sections)
- `renderAssistantBlocks()` → segments tool runs vs single blocks, creates block wrappers
- `renderTextContent()` → markdown rendering with show-more collapse (>10 lines), copy button
- `renderThinkingBlock()` → ghost-style collapsible, 55% opacity
- `buildAnsiDom()` → programmatic ANSI → DOM (4-bit + 24-bit color, bold, dim, italic, underline)
- Mermaid detection via MutationObserver → wrapper with click-to-expand modal, SVG ID remapping

### Tool Renderer (`tool-renderer.ts`)

- `renderToolGroup()` → groups consecutive tools above threshold into collapsible group
- `renderToolCall()` → compact bar header (indicator, name, preview, duration, hooks, chevron) + expandable body
- Tool-specific renderers: `renderBashInput()`, `renderDiffView()` (Edit), `renderWriteView()`, Read (language-specific), Bash diff detection
- `renderSubAgentSession()` → collapsible PROMPT + flattened blocks + OUTPUT
- `toolPreview()` → compact header previews per tool type
- `parseMcpToolName()` → splits `mcp__server__tool` format
- Task tool rendering with cumulative state tracking

### Summary Renderer (`summary-renderer.ts`)

- Pinned heroes bar (sticky) + collapsible summary panel
- Hero cards: cost, context window, turns, duration
- Token usage chart: stacked input bar (cache read/write/uncached) + output bar
- Tool usage horizontal bar chart
- Metadata grid: project, model, version, branch, start time, duration, cwd
- Session ID/resume/URI rows with copy buttons

### Search View (`search-view.ts`)

- `ItemView` in right split, type `claude-sessions-search`
- Cross-session mode: `searchSessions()` with progressive results, grouped by session
- In-session mode: `searchFile()` scoped to active timeline, with DOM highlighting via `navigateToMatch()`
- Role filter, debounced input, AbortController cancellation, arrow key navigation
- State persisted via `getState()`/`setState()`

## HTML Export Pipeline (`exporters/`)

DOM snapshot approach — captures already-rendered timeline:

1. **`css-capture.ts`** — scrapes CSS at export time:
   - `captureThemeVariables()` — resolves all `--*` properties via `getComputedStyle()`
   - `captureMarkdownStyles()` — extracts `app.css` rules for markdown/PrismJS/SVG
   - `capturePluginStyles()` — extracts plugin stylesheet (detected by `claude-sessions` in first rule)
   - `captureFontFaces()` — embedded (data:) font sources

2. **`standalone-player.ts`** — JS string for `<script>` tag:
   - Event delegation for collapsibles, copy, show-more, image modal, mermaid modal, content filters
   - Collapsibles use CSS class toggling (`open`/`collapsed`) matching live view pattern
   - Copy fallback: `document.execCommand('copy')` for `file://` protocol

3. **`html-exporter.ts`** — orchestrator:
   - `snapshotTimeline()` — deep clone, add `visible` class, process copy buttons (extract closure text to `data-copy-text`)
   - Strips pinned heroes bar (live-only feature)
   - Saves via Electron `remote.dialog.showSaveDialog()`, falls back to writing next to session file

## CSS Class Conventions

- **Outer containers**: `claude-sessions-summary-*` (summary panel, header, chevron, copy buttons)
- **Dashboard inner**: `claude-sessions-dash-*` (heroes, charts, meta grid, IDs)
- **Tool blocks**: `claude-sessions-tool-*` (block, header, body, indicator, name, preview, etc.)
- **Filtering**: `claude-sessions-filtered` class toggles `display: none`
- **States**: `open` (tools, thinking, summary, sub-agents), `collapsed` (turns), `is-collapsed` (show-more), `visible` (IntersectionObserver), `is-pinned` (heroes bar)

## Commands

| ID | Name |
|---|---|
| `browse-sessions` | Browse sessions |
| `search-sessions` | Search sessions |
| `import-file` | Import session file |
| `export-markdown` | Export session to Markdown |
| `export-html` | Export session to HTML |
| `expand-all` | Expand all turns |
| `collapse-all` | Collapse all turns |
| `refresh-session` | Refresh session |
| `toggle-live-watch` | Toggle live watch |
| `search-in-session` | Search in session |
| `copy-resume-command` | Copy resume command |

## Security Notes

- No `innerHTML` in renderer pipeline — all content built via `createEl`/`createSpan`/`appendText`
- `SAFE_IMAGE_TYPES` whitelist for clipboard copy
- `path.basename()` on drag-and-drop filenames prevents path traversal
- `escapeHtml()` in HTML export header for metadata strings
- Protocol handler reads local files only — no network exposure
- Electron `remote` API for save dialog (deprecated, monitor for future Obsidian versions)
- ANSI inline styles use numeric RGB values from escape codes — no injection vector
