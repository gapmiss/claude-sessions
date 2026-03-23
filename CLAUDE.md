# Agent Sessions — Obsidian Plugin

## Origin

Inspired by [claude-replay](https://github.com/es617/claude-replay), this plugin brings AI coding agent session replay natively into Obsidian. Rather than a standalone web app, sessions live alongside your notes — importable, replayable, and exportable as markdown or self-contained HTML.

## Status

**v0.1.0 — Desktop-only. Claude Code session replay with summary panel, deep linking, and rich tool rendering.**

Working features:
- **Claude Code only** — focused exclusively on Claude Code JSONL session format (Codex/Cursor parsers removed)
- Claude Code JSONL parser with record merging, deduplication, tool result attachment, and token usage extraction
- Per-record timestamps preserved on content blocks for segment-level timing
- Thinking blocks parsed from plaintext (v2.1.50); encrypted/signature-only blocks (v2.1.79+) silently skipped
- Hook event parsing from `hook_progress` records, attached to tool use blocks by `toolUseID`
- `/exit` command consolidation — three records collapsed into single "*Session ended*" message
- Local command tags (`<local-command-stdout>`, `<local-command-caveat>`) stripped from user content
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
- **Obsidian protocol handler**: `obsidian://agent-sessions?session=/path/to/session.jsonl` opens session directly
- Timeline replay view — all turns visible and scrollable from the start
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
- Collapsible turn headers with `#N` label and timestamp
- Role sections with colored left borders (accent for USER, cyan for CLAUDE)
- **Live watch** with file watcher — auto-reloads session on file change
  - **UI state preservation** across re-renders: expanded tool blocks, "show more" sections, scroll position, turn collapse, and summary panel state all persist
  - **Auto-scroll setting** — toggle whether live updates scroll to bottom or preserve position
- **Cached session index** — persists metadata to `session-index.json`; only new/modified files re-read on browse
- **Async line-by-line metadata extraction** — skips large record types (file-history-snapshot, queue-operation, progress) by prefix check; reads up to 100 lines
- **Empty session filtering** — sessions with zero user/assistant records are hidden from the browser
- Session browser (SuggestModal) — scans dirs before opening for synchronous getItems()
- File picker modal with drag-and-drop, path input, and session directory path resolution fallback
- Markdown export with frontmatter and Obsidian callouts
- HTML export as self-contained replay file with embedded player
- Settings tab: session directories, export preferences, display toggles (thinking, tool calls, tool results, hook icons), tool group threshold, auto-scroll on update
- ESLint with `eslint-plugin-obsidianmd` recommended rules
- **Keyboard accessible**: all collapsible headers (turns, summary, tools, tool groups, thinking, sub-agent prompts) have `tabindex`, `role="button"`, `aria-expanded`, and Enter/Space handlers via `makeClickable()` helper; image thumbnails keyboard-activatable; show-more buttons track `aria-expanded`; document-level arrow key handler guards against input/textarea/contentEditable; `restoreUIState()` syncs ARIA attributes after live reload re-renders
- **Progress bar**: `role="progressbar"` with live `aria-valuetext` (e.g. "Turn 5 of 42 · 3:21 / 15:00"); read-only (not keyboard-interactive) since scroll-driven position conflicts with arrow key navigation
- **Focus-visible indicators**: `:focus-visible` outlines on all interactive headers (inset), image thumbnails (outset), drop zone, and file picker browse button; text copy buttons visible on `:focus-within`; thinking blocks opacity bump on `:focus-within`
- **File picker accessibility**: browse link is a `<button>` with CSS reset for inline appearance; drop zone has `tabindex`, `role="button"`, and Enter/Space handler
- 44px minimum touch targets on all interactive elements

## Key Implementation Details

### Claude JSONL Parser (`parsers/claude-parser.ts`)

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
4. **`isSidechain` and `isMeta` records are skipped.**
5. **Per-record timestamps are propagated to content blocks** — `record.timestamp` is set on each `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, and `ToolResultBlock` for segment-level timing.
6. **Encrypted thinking blocks (signature-only) are skipped** — Claude Code v2.1.79+ encrypts thinking content. Only plaintext thinking blocks are rendered.
7. **Hook events** are collected from `hook_progress` records, mapped by `toolUseID`, and attached to corresponding `ToolUseBlock.hooks[]` after turns are built.
8. **Token usage** is extracted from `message.usage` on assistant records, deduplicated by message ID (keeping the max of each field across streaming duplicates), then summed into `SessionStats`.
9. **Exit consolidation** — records containing `<command-name>/exit</command-name>` produce a single "*Session ended*" text block. Following `<local-command-stdout>` and `<local-command-caveat>` records are skipped.
10. **Orphan vs pending** — tool_use blocks without a matching tool_result are marked `isPending` if on the last assistant turn (likely still running), or `isOrphaned` if mid-session (genuinely interrupted).
11. **Task notification capture** — `<task-notification>` XML from `queue-operation` and `user` records is parsed before those records are skipped. Extracts `tool-use-id`, `task-id`, `result`, `summary` and creates `SubAgentSession` stubs with `isBackground: true` and empty turns.
12. **Sub-agent JSONL resolution** — `resolveSubAgentSessions()` reads `<sessionBase>/subagents/agent-<agentId>.jsonl` for all sub-agents (foreground and background). Uses `allowSidechain: true` since subagent JSONL records are marked `isSidechain`. Replaces stub turns with fully parsed content.

### Session Statistics (`types.ts: SessionStats`)

Computed during parsing and stored on `Session.stats`:
- `inputTokens` / `outputTokens` — raw token counts (input is typically small due to caching)
- `cacheReadTokens` / `cacheCreationTokens` — where most input usage actually lives
- `toolUseCounts` — `Record<string, number>` of tool name → invocation count
- `userTurns` / `assistantTurns` — role-based turn counts
- `durationMs` — elapsed time from first to last timestamp

### Replay View (`views/replay-view.ts`)

- Extends `ItemView` with type `agent-sessions-replay`
- **All turns rendered immediately** into a scrollable timeline — content is never hidden
- `IntersectionObserver` on the timeline container watches each turn element; turns in viewport get `visible` class (opacity 1.0), others dim to 0.3
- **Segment-level navigation**: arrow keys move a highlight cursor (`block-active`) through segments within turns, then across turns. A segment is: one text block, one thinking block, or one run of consecutive tool calls.
- **Segment-level playback**: `animateCurrentTurn()` → `playNextSegment()` walks through segments with real timestamp delays (clamped 600ms–10s, fallback 800ms), scaled by `playbackSpeed`. After all segments in a turn, 500ms dwell then advance to next turn.
- **Segment timing data**: `segmentMs[]` (flat array of segment timestamps as ms offsets from session start), `segmentStartIdx[]` (first flat index per turn).
- **Progress bar**: dots positioned per-segment by real timestamp. `segmentFromPct()` maps click position to `{turnIdx, blockIdx}` for seek.
- `getState()`/`setState()` persist turn position for workspace restore
- **UI state preservation**: `captureUIState()` / `restoreUIState()` save and restore collapsed turns, summary panel, expanded tool blocks (by turn+block index), expanded "show more" sections (by turn+wrap index), scroll position, and ARIA `aria-expanded` attributes across full re-renders
- **Content filters**: `FilterState` tracks 8 toggles in two groups — User (text, images) and Assistant (text, thinking, tool calls, tool results). Parent toggles hide entire role sections; children toggle individual block types.

### Replay Renderer (`views/replay-renderer.ts`)

- `renderTimeline(turns, sessionStartMs, session?)` — renders summary panel (if session provided) + all turns, returns array of turn elements
- `renderSummary(session, container)` — collapsible panel with metadata grid, token stats, tool breakdown, copyable IDs and URIs
- **Tool-specific input rendering**:
  - `Bash` → `renderBashInput()`: `` ```bash `` code block with description label
  - `Edit` → `renderDiffView()`: red/green diff lines; only shows result on error
  - `Write` → `renderWriteView()`: syntax-highlighted code block via `langFromPath()`; only shows result on error
  - Other tools → JSON code block
- **Tool-specific result rendering**:
  - `Read` → language-specific highlighting based on file extension, line numbers stripped
  - `Bash` with diff command → `` ```diff `` code block (detected via `isBashDiffResult()`)
  - Other → plain code block
- **Hook indicators**: fish icon on tool call headers when `block.hooks` is present and `settings.showHookIcons` is enabled, tooltip shows hook names
- **Text blocks** wrapped in `.agent-sessions-text-block` with hover-reveal copy button
- **Image blocks**: thumbnail with click handler → `ImagePreviewModal` (full-size view + Download + Copy buttons)
- **Sub-agent rendering**: `renderSubAgentSession()` flattens all assistant blocks across turns with `groupThreshold: 0` (every tool run collapses), preserving text blocks between tool groups for chain-of-thought context
- Tool grouping: configurable via `settings.toolGroupThreshold` (default 4); calls above threshold collapse into group header; `renderAssistantBlocks()` and `renderToolGroup()` accept optional `groupThreshold` override
- Long text (>10 lines) wrapped in collapsible with fade gradient
- `getBlockWrappers(turnIndex)` returns all wrapper elements within a turn

### Protocol Handler (`main.ts`)

- Registered via `registerObsidianProtocolHandler('agent-sessions', ...)`
- URI format: `obsidian://agent-sessions?session=/full/path/to/session.jsonl`
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
  parsers/
    base-parser.ts                 # Abstract base with shared utilities
    claude-parser.ts               # Claude Code JSONL parser (merges records, extracts stats + hooks)
    detect.ts                      # Parser detection (Claude-only)
  views/
    replay-view.ts                 # ItemView — scrollable timeline with IntersectionObserver
    replay-renderer.ts             # DOM rendering (summary, timeline, tool bars, diff view, collapsibles)
    session-browser-modal.ts       # SuggestModal + scanSessionDirs() with cached index
    file-picker-modal.ts           # Import from arbitrary path (drag-and-drop, path input)
  exporters/
    markdown-exporter.ts           # Markdown with frontmatter & callouts
    html-exporter.ts               # Self-contained HTML replay
  utils/
    path-utils.ts                  # Home dir expansion, path helpers
    session-index.ts               # Cached session metadata index (JSON on disk)
    streaming-reader.ts            # File reading (Node.js streams on desktop)
styles.css                         # Scoped styles using Obsidian CSS variables
eslint.config.mjs                  # ESLint flat config with eslint-plugin-obsidianmd
```

## Commands

| ID | Name |
|---|---|
| `browse-sessions` | Browse sessions |
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
npx eslint .     # lint with eslint-plugin-obsidianmd rules
```

Build script automatically copies `main.js`, `styles.css`, and `manifest.json` to `~/Vaults/Master/.obsidian/plugins/agent-sessions/`.

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
- Session index cache uses `mtime` as staleness key — fast stat() check avoids re-reading unchanged files. Store in `.obsidian/plugins/agent-sessions/session-index.json` via direct `fs` (desktop-only).
- Live reload re-renders the entire DOM — UI state (expanded tools, show-more, scroll position) must be captured before and restored after. Keyed by turn+block index, which is stable as long as turns aren't reordered (safe for append-only JSONL).
- Progress bar dots must be reused in place (not destroyed/recreated) to avoid flicker during live reload. Diff the count: reposition existing, append new, remove excess.
- `agent_progress` records stream only `tool_use` and `tool_result` blocks — assistant text blocks are omitted. Must read the subagent's own JSONL file (`subagents/agent-<id>.jsonl`) to recover chain-of-thought text for both foreground and background agents.
- Subagent JSONL files mark every record as `isSidechain: true` — parser needs `allowSidechain: true` constructor option to avoid filtering them out.
- Background agents don't produce `agent_progress` records at all. Their completion arrives as `<task-notification>` XML in `queue-operation` or `user` records, which must be captured before those record types are skipped.

## Roadmap

### Near-term
- [ ] Incremental parsing — track byte/line offset, only parse new lines on reload
- [ ] Incremental DOM rendering — append new turns instead of full re-render
- [ ] Progress bar/notice for large file imports (10MB+)
- [ ] Search/filter sessions by project, date range, or model
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
