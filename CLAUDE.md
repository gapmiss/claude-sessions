# Agent Sessions — Obsidian Plugin

## Origin

Inspired by [claude-replay](https://github.com/es617/claude-replay), this plugin brings AI coding agent session replay natively into Obsidian. Rather than a standalone web app, sessions live alongside your notes — importable, replayable, and exportable as markdown or self-contained HTML.

The claude-replay repo is cloned at `/tmp/claude-replay` for reference. Its `template/player.html` (2499 lines) contains the complete CSS and JS player that informed our rendering approach. Licensed MIT.

## Status

**v0.2.0 — Segment-level navigation and playback.**

Working features:
- Claude Code JSONL parser with record merging, deduplication, and tool result attachment
- Per-record timestamps preserved on content blocks for segment-level timing
- Codex CLI parser (event-based format)
- Cursor parser (stub — detection only)
- Auto-format detection from first lines of file
- Timeline replay view — all turns visible and scrollable from the start
- Segment-level navigation: arrow keys step through segments (text, thinking, tool run) within turns
- Segment-level playback: reveals segments with real timestamp-based delays (clamped 600ms–10s)
- Active segment highlighted with accent left border + spinner on tool/thinking blocks
- Progress bar dots = one per segment, positioned by real timestamp
- Progress bar counter = real elapsed time, updates live on scroll
- Scroll-based opacity via IntersectionObserver (turns fade in as they enter viewport)
- Scroll listener syncs timer to topmost visible segment during free browsing
- Click-to-seek on progress bar targets specific segment (turn + block)
- Keyboard shortcuts: Arrow keys (segment nav), Space (play/pause), `[`/`]` (speed)
- Tool calls as compact bars: status dot (blue/red), bold name, arg preview, expand chevron
- Diff view for Edit tool calls (red/green lines)
- Tool grouping: 5+ consecutive calls collapse into `▸ N tool calls Name, Name`
- Thinking blocks as collapsible left-bordered sections
- "Show more" with fade gradient for long text blocks (10+ lines)
- Collapsible turn headers with `#N` label and timestamp
- Role sections with colored left borders (accent for USER, cyan for CLAUDE)
- Session browser (FuzzySuggestModal) — scans dirs before opening for synchronous getItems()
- File picker modal for arbitrary .jsonl import
- Markdown export with frontmatter and Obsidian callouts
- HTML export as self-contained replay file with embedded player
- Settings tab: session directories (with Add button), export preferences, display toggles
- Accessible: ARIA labels, focus-visible indicators, 44px touch targets

## Key Implementation Details

### Claude JSONL Parser (`parsers/claude-parser.ts`)

The Claude Code JSONL format has these record types:
- `user` — either actual user text (`message.content` is a string) or tool results (`message.content` is an array of `{type: "tool_result", tool_use_id, content}` blocks)
- `assistant` — each content block (thinking, text, tool_use) is a **separate record** with its own uuid. A single logical assistant turn spans multiple consecutive records.
- `file-history-snapshot`, `progress`, `queue-operation` — skipped (non-content)

**Critical parsing logic:**
1. **Consecutive assistant records are merged into a single Turn.** The parser accumulates assistant blocks until a user record with actual text content arrives, then flushes.
2. **Tool results from user records are attached to the preceding assistant turn**, not created as separate user turns. A user record with only `tool_result` blocks and no text content produces no user turn.
3. **Deduplication by uuid** — streaming produces multiple records with the same uuid; we keep the last (most complete) version.
4. **`isSidechain` records are skipped** — these are branch explorations.
5. **Per-record timestamps are propagated to content blocks** — `record.timestamp` is set on each `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, and `ToolResultBlock` for segment-level timing.

### Replay View (`views/replay-view.ts`)

- Extends `ItemView` with type `agent-sessions-replay`
- **All turns rendered immediately** into a scrollable timeline — content is never hidden
- `IntersectionObserver` on the timeline container watches each turn element; turns in viewport get `visible` class (opacity 1.0), others dim to 0.3
- **Segment-level navigation**: arrow keys move a highlight cursor (`block-active`) through segments within turns, then across turns. A segment is: one text block, one thinking block, or one run of consecutive tool calls.
- **Segment-level playback**: `animateCurrentTurn()` → `playNextSegment()` walks through segments with real timestamp delays (clamped 600ms–10s, fallback 800ms), scaled by `playbackSpeed`. After all segments in a turn, 500ms dwell then advance to next turn.
- `activeBlockIdx` tracks the highlighted segment within the current turn (-1 = none)
- `setActiveBlock(turnIdx, blockIdx)` clears previous highlight, applies `block-active` class, scrolls into view
- **Segment timing data**: `segmentMs[]` (flat array of segment timestamps as ms offsets from session start), `segmentStartIdx[]` (first flat index per turn). Built by `computeSegmentTiming()` during `computeTiming()`.
- **Progress bar**: dots positioned per-segment by real timestamp. `segmentFromPct()` maps click position to `{turnIdx, blockIdx}` for seek.
- **Live scroll timer**: scroll event listener on timeline calls `syncTimerToScroll()`, which finds the topmost visible block wrapper in the active turn and updates `displayedTimeMs` from `segmentMs[]`.
- `syncTimerToBlock()` uses actual segment timestamp from `segmentMs[]` (not interpolation)
- `getState()`/`setState()` persist turn position for workspace restore

### Replay Renderer (`views/replay-renderer.ts`)

- `renderTimeline(turns)` — renders all turns, returns array of turn elements for observer
- **Each segment wrapped in `.block-wrapper[data-block-idx]`** — enables highlight-based navigation without hiding content
- User text blocks and assistant segments (text, thinking, tool runs) all get wrappers with sequential `data-block-idx` within their turn
- Consecutive `tool_use` + `tool_result` blocks are grouped into tool runs
- Tool runs of ≤4 render individually; 5+ collapse into a group header
- Each tool call bar shows: indicator dot (blue=ok, red=error), bold name, preview text (file_path for Read/Write/Edit, command for Bash, pattern for Grep/Glob), expand chevron
- **Spinner elements** (`.block-spinner`) on tool headers, tool group headers, and thinking headers — visible only when parent wrapper has `block-active`
- Edit tool calls render as diff view (red deletions, green additions) instead of raw JSON
- Text blocks use `MarkdownRenderer.render()` for syntax highlighting
- Long text (>10 lines) wrapped in collapsible with fade gradient and "Show more (N lines)" toggle
- `getBlockWrappers(turnIndex)` returns all wrapper elements within a turn for the view to query

### Session Browser Modal (`views/session-browser-modal.ts`)

- Directory scanning happens **before** opening the modal (async `scanSessionDirs()` in main.ts)
- Results passed to constructor so `getItems()` returns synchronously — avoids `FuzzySuggestModal` timing issues
- Previous approach of dispatching input events to refresh caused infinite recursion

### Settings (`settings.ts`)

- Settings interface and defaults live in `types.ts`, re-exported from `settings.ts`
- "Add session directory" has both Enter-key handler and explicit "Add" button
- Types must use `export type` for interfaces due to `isolatedModules`

## Architecture

```
src/
  main.ts                          # Plugin entry, commands, view registration
  settings.ts                      # Settings tab
  types.ts                         # Shared interfaces (Session, Turn, ContentBlock, etc.)
  parsers/
    base-parser.ts                 # Abstract base with shared utilities
    claude-parser.ts               # Claude Code JSONL parser (merges consecutive records)
    codex-parser.ts                # Codex CLI parser
    cursor-parser.ts               # Cursor transcript parser (stub)
    detect.ts                      # Format auto-detection
  views/
    replay-view.ts                 # ItemView — scrollable timeline with IntersectionObserver
    replay-renderer.ts             # DOM rendering (timeline, tool bars, diff view, collapsibles)
    session-browser-modal.ts       # FuzzySuggestModal + scanSessionDirs() pre-scan
    file-picker-modal.ts           # Import from arbitrary path
  exporters/
    markdown-exporter.ts           # Markdown with frontmatter & callouts
    html-exporter.ts               # Self-contained HTML replay
  utils/
    path-utils.ts                  # Home dir expansion, path helpers
    streaming-reader.ts            # File reading (Node.js streams on desktop)
styles.css                         # Scoped styles using Obsidian CSS variables
```

## Commands

| ID | Name |
|---|---|
| `browse-sessions` | Browse agent sessions |
| `import-file` | Import session file |
| `export-markdown` | Export session to markdown |
| `export-html` | Export session to HTML |
| `toggle-playback` | Toggle session playback |
| `next-turn` | Go to next turn |
| `prev-turn` | Go to previous turn |

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # production build (typecheck + bundle)
```

Copy `main.js`, `styles.css`, and `manifest.json` to your vault's `.obsidian/plugins/agent-sessions/` directory.

## Gotchas & Lessons Learned

- `FuzzySuggestModal.getItems()` is called synchronously — async data must be loaded before `.open()`
- Dispatching synthetic `input` events on the modal's inputEl causes infinite recursion with Obsidian's `onInput` handler
- `WorkspaceLeaf.updateHeader()` is not in the type definitions — cast through `unknown`
- `Component` doesn't have `.app` — pass `App` separately to the renderer
- `export type` required for interfaces when `isolatedModules` is enabled
- Obsidian CSS variables like `--color-cyan`, `--color-blue`, `--color-red`, `--color-green` provide theme-aware colors for tool indicators and diff views
- Claude Code streams each assistant content block as a separate JSONL record with its own uuid — must merge consecutive assistant records or tool results end up orphaned

## Roadmap

### Near-term
- [ ] Cursor parser — full implementation once transcript format is documented
- [ ] Progress bar/notice for large file imports (10MB+)
- [ ] Vault-based session browsing for mobile support
- [ ] Search/filter sessions by project, date range, or model
- [ ] Persist last-viewed turn per session across restarts (setState/getState)
- [x] ~~Block-level playback animation~~ — segment-level navigation and playback with real timestamp delays

### Medium-term
- [x] ~~Diff view for tool results~~ — Edit tool calls render as red/green diff
- [x] ~~Multi-turn view~~ — full scrollable timeline with all turns visible
- [ ] Session statistics panel (token counts, tool usage breakdown, duration)
- [ ] Linked mentions — link tool_use file paths to vault files when they exist
- [ ] Tag/bookmark individual turns for later reference
- [ ] Write tool calls render file content with syntax highlighting

### Long-term
- [ ] Session comparison — side-by-side diff of two sessions
- [ ] Cost estimation from token usage metadata
- [ ] Timeline visualization of session flow
- [ ] Plugin API for custom parsers (third-party agent formats)
- [ ] Obsidian Publish-compatible export theme
