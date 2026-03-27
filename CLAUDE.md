# Claude Sessions — Obsidian Plugin

## Origin

This plugin brings Claude Code session viewing natively into Obsidian. Rather than a standalone web app, sessions live alongside your notes — importable, browsable, and exportable as markdown or self-contained HTML.

## Status

**v0.1.0 — Desktop-only. Claude Code session viewer with summary panel, deep linking, and rich tool rendering.**

Working features:
- **Claude Code only** — focused exclusively on Claude Code JSONL session format (Codex/Cursor parsers removed)
- Claude Code JSONL parser with record merging, deduplication, tool result attachment, and token usage extraction
- Per-record timestamps preserved on content blocks for segment-level timing
- Thinking blocks parsed from plaintext (v2.1.50); encrypted/signature-only blocks (v2.1.79+) silently skipped
- Hook event parsing from `hook_progress` records, attached to tool use blocks by `toolUseID`
- `/exit` command consolidation — three records collapsed into single "*Session ended*" message
- Local command tags (`<local-command-stdout>`, `<local-command-caveat>`) stripped from user content
- **Slash command / skill output** — skill commands (e.g. `/wrap:wrap`) render the user-facing name (`/wrap`) and a collapsible "Slash output" card with the full skill expansion prompt rendered as markdown
  - Skill commands identified by `<command-message>` tag presence; built-in commands (`/compact`, `/context`) unaffected
  - `isMeta` user records following a slash command are captured as `SlashCommandBlock`; other `isMeta` records still skipped
  - `<system-reminder>` tags stripped from expansion text
- **Sub-agent sessions** parsed and rendered inline with collapsible PROMPT, flattened tool groups (threshold 0), and collapsible OUTPUT with markdown rendering and copy button
  - **Foreground agents** stream `agent_progress` records with `parentToolUseID`; parsed via `buildSubAgentSession()`
  - **Background agents** (`run_in_background: true`) arrive via `<task-notification>` XML in `queue-operation`/`user` records; marked `isBackground: true`
  - Both types resolved from `<sessionBase>/subagents/agent-<agentId>.jsonl` via `resolveSubAgentSessions()` to recover full chain-of-thought text
- **Orphaned tool call status**: last-turn tool calls without results show "in progress" (likely still running); mid-session orphans show "interrupted"
- **Session summary panel** (collapsible) at top of timeline:
  - Inline token count and turn count in collapsed header
  - Session ID with copy buttons (ID only + full JSONL path)
  - Obsidian URI with copy buttons (raw URI + markdown link)
  - Metadata grid: project, model, version, branch, cwd, start time, duration
  - Token breakdown: total input (cache read + cache write + uncached), output
  - Tool usage breakdown sorted by count descending
  - User/assistant/total turn counts
- **Obsidian protocol handler**: `obsidian://claude-sessions?session=/path/to/session.jsonl` opens session directly
- Timeline view — all turns visible and scrollable from the start
- Segment-level navigation: arrow keys step through segments (text, thinking, tool run) within turns
- Segment-level playback: reveals segments with real timestamp-based delays (clamped 600ms–10s)
- Active segment highlighted with accent left border + spinner on tool/thinking blocks
- Progress bar dots = one per segment, positioned by real timestamp; dots reused in place on re-render (no flicker)
- Progress bar counter = real elapsed time, updates live on scroll
- Scroll-based opacity via IntersectionObserver (turns fade in as they enter viewport)
- Click-to-seek on progress bar targets specific segment (turn + block)
- Keyboard shortcuts: Arrow keys (segment nav), Space (play/pause), `[`/`]` (speed)
- **Content filter menu** (⋯ button): hierarchical toggles for User (text, images) and Assistant (text, thinking, tool calls, tool results)
- Tool calls as compact bars: status dot (blue/red/orange), bold name, arg preview, hook icon (fish) with tooltip, expand chevron
- **Bash tool input** rendered as `` ```bash `` code block with description next to INPUT label
- **Bash diff detection**: results from commands containing `diff` render as `` ```diff `` code block when output matches unified diff format
- **Edit tool** renders as diff view (red/green lines); success messages hidden (errors only)
- **Write tool** renders file content as syntax-highlighted code block; success messages hidden (errors only)
- **Read tool results** use language-specific highlighting based on file extension via `langFromPath()`
- Tool grouping: consecutive calls above configurable threshold (default 4) collapse into `▸ N tool calls Name, Name`
- Thinking blocks as ghost-style collapsible cards: brain icon, 55% opacity (85% on hover/open/focus)
- Copy-to-clipboard buttons on user/assistant text blocks (hover to reveal)
- Image blocks with thumbnail preview, click-to-zoom modal with Download and Copy buttons
- "Show more" with fade gradient for long text blocks (10+ lines)
- Collapsible turn headers with role label (USER/CLAUDE) and `(Turn #N)` — role color in header, content sections retain colored left borders
- **Live watch** with file watcher — auto-reloads session on file change
  - **UI state preservation** across re-renders: expanded tool blocks, "show more" sections, scroll position, turn collapse, and summary panel state all persist
  - **Auto-scroll setting** — toggle whether live updates scroll to bottom or preserve position
- **Cached session index** — persists metadata to `session-index.json`; only new/modified files re-read on browse
- **Async line-by-line metadata extraction** — skips large record types (file-history-snapshot, queue-operation, progress) by prefix check; reads up to 100 lines
- **Empty session filtering** — sessions with zero user/assistant records are hidden from the browser
- **Search side panel** (`ItemView` in right split) — dual-mode search with persistent results
  - **Cross-session mode** ("All sessions"): keyword search across all JSONL files with progressive results
  - **In-session mode** ("Current session"): scoped to active timeline view's session with timestamp-based turn resolution and DOM highlighting
  - Mode toggle buttons, scope label showing active session path
  - On-demand line-by-line grep using Node.js `readline` (no persistent index)
  - Role filter (all/user/assistant), debounced input, `AbortController` cancellation
  - Results grouped by session with `<mark>`-highlighted match snippets (75-char context)
  - Arrow key navigation between results, "+N more" expander per session, active result highlighting
  - Processes newest sessions first (sorted by mtime)
  - `getState()`/`setState()` persist mode, query, and role filter across workspace restores
- Session browser (SuggestModal) — scans dirs before opening for synchronous getItems()
- File picker modal with drag-and-drop, path input, and session directory path resolution fallback
- Markdown export with frontmatter and Obsidian callouts
- **HTML export** as self-contained, zero-dependency HTML file via DOM snapshot
  - Captures live timeline view DOM (all markdown already rendered by Obsidian)
  - CSS captured at export time: theme variables (822 `--*` properties), relevant `app.css` rules (markdown rendering, PrismJS syntax highlighting, SVG icons), plugin `styles.css`
  - Standalone JS (~4KB) handles collapsibles, copy-to-clipboard, show-more, image zoom modal, content filter menu via event delegation
  - Electron save dialog with fallback to session directory
  - All images inline as base64 data URIs
  - All interactive features preserved: turn/tool/thinking/summary collapse, tool groups, sub-agent sessions, show-more, code copy buttons
- Settings tab: session directories, export preferences, display toggles (thinking, tool calls, tool results, hook icons), tool group threshold, auto-scroll on update
- ESLint with `eslint-plugin-obsidianmd` recommended rules
- **Keyboard accessible**: all collapsible headers (turns, summary, tools, tool groups, thinking, sub-agent prompts) have `tabindex`, `role="button"`, `aria-expanded`, and Enter/Space handlers via `makeClickable()` helper; image thumbnails keyboard-activatable; show-more buttons track `aria-expanded`; document-level arrow key handler guards against input/textarea/contentEditable; `restoreUIState()` syncs ARIA attributes after live reload re-renders
- **Progress bar**: `role="progressbar"` with live `aria-valuetext` (e.g. "Turn 5 of 42 · 3:21 / 15:00"); read-only (not keyboard-interactive) since scroll-driven position conflicts with arrow key navigation
- **Focus-visible indicators**: `:focus-visible` outlines on all interactive headers (inset), image thumbnails (outset), drop zone, and file picker browse button; text copy buttons visible on `:focus-within`; thinking blocks opacity bump on `:focus-within`
- **File picker accessibility**: browse link is a `<button>` with CSS reset for inline appearance; drop zone has `tabindex`, `role="button"`, and Enter/Space handler
- 44px minimum touch targets on all interactive elements

## Key Implementation Details

### Claude JSONL Parser (decomposed across 4 files)

**`constants.ts`** — All JSONL protocol strings centralized for single-point-of-update:
- Record types: `RT_USER`, `RT_ASSISTANT`, `SKIP_RECORD_TYPES`
- Block types: `BT_TEXT`, `BT_THINKING`, `BT_TOOL_USE`, `BT_TOOL_RESULT`, `BT_IMAGE`
- XML tags: `TAG_TASK_NOTIFICATION`, `RE_EXIT_COMMAND`, `RE_SLASH_COMMAND`, etc.
- Display strings: `TEXT_SESSION_ENDED`, `TEXT_INTERRUPTION`, `MODEL_SYNTHETIC`
- Tool names: `SUBAGENT_TOOL_NAMES`, `ANSI_COMMANDS`

**`parsers/claude-content.ts`** (~127 lines) — Stateless content extraction:
- `parseContentBlock()` — routes by block type, returns typed ContentBlock or null
- `extractToolResultBlocks()` — extracts tool results from user record message arrays
- `isInterruptionMessage()` — detects user interruption messages
- `basename()` — path utility with null guard

**`parsers/claude-subagent.ts`** (~48 lines) — Sub-agent resolution:
- `parseTaskNotification()` — extracts fields from `<task-notification>` XML
- `resolveSubAgentSessions()` — reads subagent JSONL files, parses with `allowSidechain: true`

**`parsers/claude-parser.ts`** (~844 lines) — Core parser orchestrator:

The Claude Code JSONL format has these record types:
- `user` — either actual user text (`message.content` is a string) or tool results (`message.content` is an array of `{type: "tool_result", tool_use_id, content}` blocks)
- `assistant` — each content block (thinking, text, tool_use) is a **separate record** with its own uuid. A single logical assistant turn spans multiple consecutive records.
- `progress` — hook events (`data.type === "hook_progress"`) and agent progress (`data.type === "agent_progress"`) are captured; all other progress records are skipped
- `queue-operation` — `<task-notification>` XML is captured for background agent results; other queue-operation records are skipped
- `file-history-snapshot` — skipped (non-content)

**Critical parsing logic:**
1. **Consecutive assistant records are merged into a single Turn.** The parser accumulates assistant blocks until a user record with actual text content arrives, then flushes.
2. **Tool results from user records are attached to the preceding assistant turn**, not created as separate user turns. A user record with only `tool_result` blocks and no text content produces no user turn.
3. **Deduplication by uuid** — streaming produces multiple records with the same uuid; we keep the last (most complete) version.
4. **`isSidechain` records are skipped. `isMeta` non-user records are skipped.** `isMeta` user records pass through to enable skill expansion capture (see step 13).
5. **Per-record timestamps are propagated to content blocks** — `record.timestamp` is set on each `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, and `ToolResultBlock` for segment-level timing.
6. **Encrypted thinking blocks (signature-only) are skipped** — Claude Code v2.1.79+ encrypts thinking content. Only plaintext thinking blocks are rendered.
7. **Hook events** are collected from `hook_progress` records, mapped by `toolUseID`, and attached to corresponding `ToolUseBlock.hooks[]` after turns are built.
8. **Token usage** is extracted from `message.usage` on assistant records, deduplicated by message ID (keeping the max of each field across streaming duplicates), then summed into `SessionStats`.
9. **Exit consolidation** — records containing `<command-name>/exit</command-name>` produce a single "*Session ended*" text block. Following `<local-command-stdout>` and `<local-command-caveat>` records are skipped.
10. **Orphan vs pending** — tool_use blocks without a matching tool_result are marked `isPending` if on the last assistant turn (likely still running), or `isOrphaned` if mid-session (genuinely interrupted).
11. **Task notification capture** — `<task-notification>` XML from `queue-operation` and `user` records is parsed before those records are skipped. Extracts `tool-use-id`, `task-id`, `result`, `summary` and creates `SubAgentSession` stubs with `isBackground: true` and empty turns.
12. **Sub-agent JSONL resolution** — `resolveSubAgentSessions()` reads `<sessionBase>/subagents/agent-<agentId>.jsonl` for all sub-agents (foreground and background). Uses `allowSidechain: true` since subagent JSONL records are marked `isSidechain`. Replaces stub turns with fully parsed content.
13. **Skill expansion capture** — Slash commands with `<command-message>` tags (skill/custom commands) set `_pendingSlashCommand`. The immediately following `isMeta` user record is captured as a `SlashCommandBlock` and merged into the command's user turn. Built-in commands (no `<command-message>`) don't set this state. Stale state is cleared when any non-isMeta user record is processed.

### Session Statistics (`types.ts: SessionStats`)

Computed during parsing and stored on `Session.stats`:
- `inputTokens` / `outputTokens` — raw token counts (input is typically small due to caching)
- `cacheReadTokens` / `cacheCreationTokens` — where most input usage actually lives
- `toolUseCounts` — `Record<string, number>` of tool name → invocation count
- `userTurns` / `assistantTurns` — role-based turn counts
- `durationMs` — elapsed time from first to last timestamp

### Timeline View (`views/timeline-view.ts`)

- Extends `ItemView` with type `claude-sessions-timeline`
- **All turns rendered immediately** into a scrollable timeline — content is never hidden
- `IntersectionObserver` on the timeline container watches each turn element; turns in viewport get `visible` class (opacity 1.0), others dim to 0.3
- **Segment-level navigation**: arrow keys move a highlight cursor (`block-active`) through segments within turns, then across turns. A segment is: one text block, one thinking block, or one run of consecutive tool calls.
- **Segment-level playback**: `animateCurrentTurn()` → `playNextSegment()` walks through segments with real timestamp delays (clamped 600ms–10s, fallback 800ms), scaled by `playbackSpeed`. After all segments in a turn, 500ms dwell then advance to next turn.
- **Segment timing data**: `segmentMs[]` (flat array of segment timestamps as ms offsets from session start), `segmentStartIdx[]` (first flat index per turn).
- **Progress bar**: dots positioned per-segment by real timestamp. `segmentFromPct()` maps click position to `{turnIdx, blockIdx}` for seek.
- `getState()`/`setState()` persist turn position for workspace restore
- **UI state preservation**: `captureUIState()` / `restoreUIState()` save and restore collapsed turns, summary panel, expanded tool blocks (by turn+block index), expanded "show more" sections (by turn+wrap index), scroll position, and ARIA `aria-expanded` attributes across full re-renders
- **Content filters**: `FilterState` tracks 8 toggles in two groups — User (text, images) and Assistant (text, thinking, tool calls, tool results). Parent toggles hide entire role sections; children toggle individual block types.

### Timeline Renderer (decomposed across 4 files)

**`views/render-helpers.ts`** — Shared utilities used by all renderer modules:
- `RenderContext` interface (`{ app, component, settings }`) threaded through all render functions
- `makeClickable()` — adds `tabindex`, `role="button"`, `aria-expanded`, Enter/Space handlers to collapsible headers
- `fence()`, `langFromPath()`, `stripLineNumbers()`, `formatElapsed()`, `addCopyButton()`
- `COLLAPSE_THRESHOLD` (10 lines), `EXT_TO_LANG` map

**`views/timeline-renderer.ts`** (~444 lines) — Core timeline orchestrator:
- `renderTimeline(turns, sessionStartMs, session?)` — renders summary panel (if session provided) + all turns, returns array of turn elements
- `renderTurn()`, `renderAssistantBlocks()`, `renderSingleBlock()` — turn structure and block routing
- `renderTextContent()`, `renderThinkingBlock()`, `renderSlashCommandBlock()`, `renderCompactionBlock()`, `renderAnsiBlock()` + `buildAnsiDom()` — programmatic DOM construction (no innerHTML)
- `ImagePreviewModal` — full-size view with Download and Copy buttons; MIME type whitelist (`SAFE_IMAGE_TYPES`)
- `getBlockWrappers(turnIndex)` returns all wrapper elements within a turn
- Constructor creates `ToolRendererDelegate` with `bind(this)` for callbacks into tool renderer

**`views/summary-renderer.ts`** (~141 lines) — `renderSummary(session, container, ctx)`:
- Collapsible panel with metadata grid, token stats, tool breakdown, copyable IDs and URIs
- Private helpers: `addGridItem()`, `formatTokens()`, `formatDuration()`

**`views/tool-renderer.ts`** (~495 lines) — All tool-specific rendering:
- `renderToolCall()`, `renderToolGroup()`, `toolPreview()` — public API
- `ToolRendererDelegate` interface — callbacks (`renderAssistantBlocks`, `renderTextContent`) to avoid circular deps with main renderer
- **Tool-specific input**: `renderBashInput()` (```bash), `renderDiffView()` (Edit diffs), `renderWriteView()` (syntax-highlighted)
- **Tool-specific results**: `Read` (language-specific highlighting), `Bash` diff detection (`isBashDiffResult()`)
- **Sub-agent rendering**: `renderSubAgentSession()` with collapsible PROMPT, flattened tool groups, and OUTPUT
- **Hook indicators**: fish icon with tooltip when `block.hooks` present

### HTML Export Pipeline (`exporters/`)

**DOM snapshot approach** — rather than rebuilding a separate renderer, the exporter captures the already-rendered timeline view:

1. **`css-capture.ts`** — at export time, scrapes CSS from the live Obsidian document:
   - `captureThemeVariables()` — iterates all stylesheets to find `--*` property names, resolves via `getComputedStyle()` to bake the user's current theme into concrete values
   - `captureMarkdownStyles()` — filters `app.css` rules matching `markdown-rendered`, PrismJS `token.*`, `svg-icon`, `copy-code-button`, `language-*`
   - `capturePluginStyles()` — extracts the plugin's own stylesheet (detected by `claude-sessions` in first rule)

2. **`standalone-player.ts`** — returns JS string (~4KB) for the `<script>` tag:
   - **Collapsibles**: event delegation on `[role="button"][aria-expanded]` — toggles `open` class on parent container (matching live view's `toggleClass('open')` pattern); turns use `collapsed` class
   - **Show-more**: toggles `is-collapsed` class on `.claude-sessions-collapsible-wrap`
   - **Copy**: `navigator.clipboard.writeText()` with `document.execCommand('copy')` fallback for `file://`
   - **Image modal**: overlay with download link and close button
   - **Content filters**: checkbox menu toggling `display: none` on role/block-type elements

3. **`html-exporter.ts`** — orchestrator:
   - `snapshotTimeline()` — deep clones timeline DOM, adds `visible` class to all turns, processes copy buttons to add `data-copy-text` attributes (replacing closure-captured text from live view)
   - `buildHeaderHTML()` — project name, model, date, duration, turn count, filter button
   - Assembles `<!DOCTYPE html>` with `<style>` (captured CSS + export overrides) + snapshot DOM + `<script>`
   - Saves via Electron `remote.dialog.showSaveDialog()`, falls back to writing next to session file

### Protocol Handler (`main.ts`)

- Registered via `registerObsidianProtocolHandler('claude-sessions', ...)`
- URI format: `obsidian://claude-sessions?session=/full/path/to/session.jsonl&turn=7`
- Calls `openSessionByPath()` which reads the file, detects format, parses, and opens in a new tab
- Supports `~` home directory expansion via `expandHome()`

### File Picker Modal (`views/file-picker-modal.ts`)

- Drag-and-drop + file input + manual path entry
- On Electron desktop, `File.path` provides the full filesystem path
- Fallback when `File.path` is unavailable: `resolveSessionPath()` searches configured session directories for the filename to recover the full path

## Architecture

```
src/
  main.ts                          # Plugin entry, commands, protocol handler, view registration
  settings.ts                      # Settings tab
  types.ts                         # Shared interfaces (Session, SessionStats, Turn, ContentBlock, HookEvent, etc.)
  constants.ts                     # JSONL protocol strings, record/block types, XML tags, display strings
  parsers/
    base-parser.ts                 # Abstract base with shared utilities
    claude-parser.ts               # Claude Code JSONL parser (merges records, extracts stats + hooks)
    claude-content.ts              # Content block parsing, tool result extraction, interruption detection
    claude-subagent.ts             # Task notification parsing, sub-agent JSONL resolution
    detect.ts                      # Parser detection (Claude-only)
  views/
    timeline-view.ts               # ItemView — scrollable timeline with IntersectionObserver
    timeline-renderer.ts           # Core timeline, turns, text, thinking, ANSI, images (~444 lines)
    render-helpers.ts              # Shared utilities: RenderContext, makeClickable, fence, langFromPath, etc.
    summary-renderer.ts            # Collapsible summary panel with metadata grid, token stats, tool breakdown
    tool-renderer.ts               # All tool-specific rendering: Bash, Edit, Write, Read, sub-agents, tool groups
    search-view.ts                 # Search side panel (ItemView) — dual-mode cross-session and in-session search
    session-browser-modal.ts       # SuggestModal + scanSessionDirs() with cached index
    file-picker-modal.ts           # Import from arbitrary path (drag-and-drop, path input)
  exporters/
    markdown-exporter.ts           # Markdown with frontmatter & callouts
    html-exporter.ts               # DOM snapshot → standalone HTML orchestrator
    css-capture.ts                 # Theme variable + app.css + plugin CSS extraction
    standalone-player.ts           # Embedded JS for collapsibles, copy, filters, image modal
  utils/
    path-utils.ts                  # Home dir expansion, path helpers
    session-index.ts               # Cached session metadata index (JSON on disk)
    session-search.ts              # Cross-session search engine (line-by-line JSONL grep)
    streaming-reader.ts            # File reading (Node.js streams on desktop)
styles.css                         # Scoped styles using Obsidian CSS variables
eslint.config.mjs                  # ESLint flat config with eslint-plugin-obsidianmd
vitest.config.ts                   # Test config with obsidian module mock
tests/
  fixtures.ts                      # Inline JSONL fixture builders for all record types
  claude-parser.test.ts            # Parser integration tests (45 tests)
  claude-content.test.ts           # Content block parsing unit tests (23 tests)
  claude-subagent.test.ts          # Task notification parsing tests (4 tests)
  session-search.test.ts           # Search content extraction unit tests (17 tests)
  __mocks__/obsidian.ts            # Minimal obsidian module mock for vitest
```

## Commands

| ID | Name |
|---|---|
| `browse-sessions` | Browse sessions |
| `search-sessions` | Search sessions |
| `import-file` | Import session file |
| `export-markdown` | Export session to Markdown |
| `export-html` | Export session to HTML |
| `toggle-playback` | Toggle session playback |
| `next-turn` | Go to next turn |
| `prev-turn` | Go to previous turn |

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # production build (typecheck + bundle + copy to vault)
npm test         # run parser tests (vitest)
npm run test:watch  # watch mode tests
npx eslint .     # lint with eslint-plugin-obsidianmd rules
```

Build script automatically copies `main.js`, `styles.css`, and `manifest.json` to `~/Vaults/Master/.obsidian/plugins/claude-sessions/` and `~/Vaults/live-mcp-for-obsidian/.obsidian/plugins/claude-sessions/`.

## Gotchas & Lessons Learned

- `FuzzySuggestModal.getItems()` is called synchronously — async data must be loaded before `.open()`
- Dispatching synthetic `input` events on the modal's inputEl causes infinite recursion with Obsidian's `onInput` handler
- `WorkspaceLeaf.updateHeader()` is not in the type definitions — cast through `unknown`
- `Component` doesn't have `.app` — pass `App` separately to the renderer
- `export type` required for interfaces when `isolatedModules` is enabled
- Obsidian CSS variables like `--color-cyan`, `--color-blue`, `--color-red`, `--color-green` provide theme-aware colors for tool indicators and diff views
- Claude Code streams each assistant content block as a separate JSONL record with its own uuid — must merge consecutive assistant records or tool results end up orphaned
- Claude Code v2.1.79+ encrypts thinking content — the `thinking` field is empty, content lives in `signature`. Parser skips these (nothing useful to display).
- `eslint-plugin-obsidianmd` recommended config exports rules as a flat object (not under `rules` key) — must wrap manually for ESLint 9 flat config. Needs `@typescript-eslint/parser` with `parserOptions.project` for type-aware rules.
- Don't `detachLeavesOfType()` in `onunload` — resets leaf position when plugin reloads
- Token usage must be deduplicated by message ID — streaming produces multiple records per message with the same usage values except `output_tokens` which grows. Keep the max of each field, then sum across messages.
- `input_tokens` in Claude Code usage is typically tiny (single digits) because prompt caching handles most input. Real input cost is in `cache_read_input_tokens` + `cache_creation_input_tokens`.
- Hook progress records have `type: "progress"` with `data.type: "hook_progress"` — must be captured before the `SKIP_TYPES` filter discards all progress records.
- Electron `File` objects from drag-and-drop have a `.path` property with the absolute filesystem path. When unavailable, search configured session directories by filename as fallback.
- Obsidian protocol handler params arrive as `Record<string, string>` from the query string; paths with special characters need `encodeURIComponent`/`decodeURIComponent`.
- Claude Code sessions often start with multiple 6KB+ `file-history-snapshot` records — reading only the first 2KB misses all metadata. Use line-by-line reading with prefix-skip for large record types instead.
- Session index cache uses `mtime` as staleness key — fast stat() check avoids re-reading unchanged files. Store in `.obsidian/plugins/claude-sessions/session-index.json` via direct `fs` (desktop-only).
- Live reload re-renders the entire DOM — UI state (expanded tools, show-more, scroll position) must be captured before and restored after. Keyed by turn+block index, which is stable as long as turns aren't reordered (safe for append-only JSONL).
- Progress bar dots must be reused in place (not destroyed/recreated) to avoid flicker during live reload. Diff the count: reposition existing, append new, remove excess.
- `agent_progress` records stream only `tool_use` and `tool_result` blocks — assistant text blocks are omitted. Must read the subagent's own JSONL file (`subagents/agent-<id>.jsonl`) to recover chain-of-thought text for both foreground and background agents.
- Subagent JSONL files mark every record as `isSidechain: true` — parser needs `allowSidechain: true` constructor option to avoid filtering them out.
- Background agents don't produce `agent_progress` records at all. Their completion arrives as `<task-notification>` XML in `queue-operation` or `user` records, which must be captured before those record types are skipped.
- All JSONL magic strings live in `constants.ts` — when Claude Code changes its schema, update one file. Parser logs `[claude-sessions] Unknown record type` / `Unknown block type` warnings with counts for format change detection.
- Token dedup uses fallback chain `msgId ?? record.uuid ?? '__anon_${counter++}'` to avoid silent data loss when `message.id` is missing.
- ANSI rendering uses programmatic DOM construction (`buildAnsiDom()`) — no `innerHTML` anywhere in the renderer pipeline.
- Image clipboard copy validates MIME type against `SAFE_IMAGE_TYPES` whitelist.
- File picker normalizes drag-and-drop filenames with `path.basename()` to prevent path traversal.
- Skill/custom slash commands use `<command-message>plugin:cmd</command-message>\n<command-name>/plugin:cmd</command-name>` format. Built-in commands omit `<command-message>`. The colon-separated name `/wrap:wrap` is displayed as `/wrap` (user-facing name). `RE_SLASH_COMMAND` allows `[\w:./-]+` in the capture group.
- `isMeta` user records with array content following a skill command carry the expanded prompt text. The parser must let `isMeta` user records through the first-pass filter to capture them in the turn-building pass.
- HTML export collapsibles must use CSS class toggling (`open`/`collapsed`), not `display` style manipulation — the CSS rules (`.claude-sessions-tool-block.open > .claude-sessions-tool-body { display: block }`) drive visibility.
- `StyleSheetList` and `CSSRuleList` don't have `[Symbol.iterator]()` in TypeScript DOM types — must use `Array.from()` before `for...of`.
- Copy buttons in the live view capture text via JS closures in `addEventListener`. The HTML export must extract text into `data-copy-text` attributes since closures don't survive DOM serialization.
- `navigator.clipboard.writeText()` requires HTTPS or localhost — exported HTML opened via `file://` needs `document.execCommand('copy')` fallback.
- The session being exported may contain its own source code (meta/self-referential sessions) — grep for script content must distinguish the actual `<script>` block from rendered code blocks in the DOM.

## Roadmap

### Near-term
- [ ] Incremental parsing — track byte/line offset, only parse new lines on reload
- [ ] Incremental DOM rendering — append new turns instead of full re-render
- [ ] Progress bar/notice for large file imports (10MB+)
- [x] ~~Search/filter sessions by project, date range, or model~~ — cross-session keyword search implemented
- [ ] Semantic search — embeddings-based search for concept-level queries
- [ ] Skip filtered blocks during segment-level navigation (arrow keys currently land on hidden blocks)

### Medium-term
- [ ] Linked mentions — link tool_use file paths to vault files when they exist
- [ ] Tag/bookmark individual turns for later reference
- [ ] Cost estimation from token usage metadata
- [ ] Session comparison — side-by-side diff of two sessions

### Long-term
- [ ] Timeline visualization of session flow
- [ ] Plugin API for custom parsers (third-party agent formats)
- [ ] Obsidian Publish-compatible export theme
- [ ] Mobile support (vault-based session browsing)

## Session State
<!-- DO NOT edit this section manually. It is managed exclusively by /wrap SKILL. -->
<!-- auto-updated by /wrap -->
- **Last session**: 2026-03-26 19:05
- **Goal**: Remove "replay" terminology — the play/forward/backward interface was removed long ago
- **Summary**: Renamed all "replay" references to "timeline" across the codebase (`bd39b51`). Files renamed (`replay-view.ts` → `timeline-view.ts`, `replay-renderer.ts` → `timeline-renderer.ts`), classes/constants/CSS updated (`ReplayView` → `TimelineView`, `VIEW_TYPE_REPLAY` → `VIEW_TYPE_TIMELINE`, `.claude-sessions-replay-container` → `.claude-sessions-timeline-container`), and user-facing description rewritten. 94 tests pass.
- **Decisions**:
  - Used "timeline" over "session" for view/renderer names — describes the UI (scrollable timeline), avoids `SessionView` ambiguity with Obsidian's own view types
  - User-facing description changed to "Browse, search, and analyze Claude Code sessions with live watch and rich tool rendering" — no mention of replay/playback
  - Settings descriptions changed "in replay" to "in session view" — more natural for end users
  - View type string changed to `claude-sessions-timeline` — breaks existing workspace tab restore, acceptable for pre-release
- **Next steps**:
  - Update CLAUDE.md documentation to reflect timeline rename (references to ReplayView, replay-view.ts, etc.)
  - Test HTML export in browser via `file://` protocol (clipboard fallback, image modal)
  - Skip filtered blocks during segment navigation (arrow keys land on hidden blocks)
  - Incremental parsing/rendering for large sessions
  - Roadmap: mark "Cost estimation from token usage metadata" as done (completed in `daad049`)
- **Blockers**: None
- **Branch**: main
- **Uncommitted**: CLAUDE.md session state update
