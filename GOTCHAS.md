# Gotchas & Lessons Learned

Reference document for known pitfalls. Not auto-included — use `@GOTCHAS.md` when working in unfamiliar areas.

## Obsidian API

- `FuzzySuggestModal.getItems()` is called synchronously — async data must be loaded before `.open()`
- Dispatching synthetic `input` events on the modal's inputEl causes infinite recursion with Obsidian's `onInput` handler
- `WorkspaceLeaf.updateHeader()` is not in the type definitions — cast through `unknown`
- `WorkspaceLeaf.updateHeader()` updates tab title but does NOT reliably refresh the inline view header title — must also set `.view-header-title` textContent directly
- `Component` doesn't have `.app` — pass `App` separately to the renderer
- `export type` required for interfaces when `isolatedModules` is enabled
- Don't `detachLeavesOfType()` in `onunload` — resets leaf position when plugin reloads
- `StyleSheetList` and `CSSRuleList` don't have `[Symbol.iterator]()` in TypeScript DOM types — must use `Array.from()` before `for...of`

## Obsidian CSS

- CSS variables `--color-cyan`, `--color-blue`, `--color-red`, `--color-green` provide theme-aware colors for tool indicators and diff views
- Obsidian renders mermaid as `div.mermaid` not `.block-language-mermaid` — discovered via live DOM inspection

## ESLint

- `eslint-plugin-obsidianmd` recommended config exports rules as a flat object (not under `rules` key) — must wrap manually for ESLint 9 flat config
- Needs `@typescript-eslint/parser` with `parserOptions.project` for type-aware rules
- Currently broken: requires `@eslint/json` package not in dependencies

## Claude Code JSONL Format

- Each assistant content block (thinking, text, tool_use) is a **separate JSONL record** with its own uuid — must merge consecutive assistant records or tool results end up orphaned
- Streaming produces multiple records with the same uuid — keep the last (most complete) version
- `input_tokens` in usage is typically tiny (single digits) because prompt caching handles most input. Real input cost is in `cache_read_input_tokens` + `cache_creation_input_tokens`
- Token usage must be deduplicated by message ID — streaming produces multiple records per message with the same usage values except `output_tokens` which grows. Keep the max of each field, then sum across messages
- Token dedup uses fallback chain `msgId ?? record.uuid ?? '__anon_${counter++}'` to avoid silent data loss when `message.id` is missing
- Claude Code v2.1.79+ encrypts thinking content — the `thinking` field is empty, content lives in `signature`. Parser skips these
- Hook progress records have `type: "progress"` with `data.type: "hook_progress"` — must be captured before the SKIP_TYPES filter discards all progress records
- Sessions often start with multiple 6KB+ `file-history-snapshot` records — reading only the first 2KB misses all metadata. Use line-by-line reading with prefix-skip for large record types instead
- `agent_progress` records stream only `tool_use` and `tool_result` blocks — assistant text blocks are omitted. Must read the subagent's own JSONL file to recover chain-of-thought text
- Subagent JSONL files mark every record as `isSidechain: true` — parser needs `allowSidechain: true`
- Background agents don't produce `agent_progress` records at all. Their completion arrives as `<task-notification>` XML in `queue-operation` or `user` records, which must be captured before those record types are skipped
- Session directory encoding (`-Users-gm-claude-sessions`) is lossy — hyphens in directory names are indistinguishable from path separators. Prefer `cwd` from session metadata; `extractProjectName()` is fallback only

## Slash Commands / Skills

- Skill/custom slash commands use `<command-message>plugin:cmd</command-message>\n<command-name>/plugin:cmd</command-name>` format. Built-in commands omit `<command-message>`
- The colon-separated name `/wrap:wrap` is displayed as `/wrap` (user-facing name). `RE_SLASH_COMMAND` allows `[\w:./-]+` in the capture group
- `isMeta` user records with array content following a skill command carry the expanded prompt text. The parser must let `isMeta` user records through the first-pass filter to capture them in the turn-building pass

## HTML Export

- Collapsibles must use CSS class toggling (`open`/`collapsed`), not `display` style manipulation — the CSS rules drive visibility
- Copy buttons in the live view capture text via JS closures in `addEventListener`. The HTML export must extract text into `data-copy-text` attributes since closures don't survive DOM serialization
- `navigator.clipboard.writeText()` requires HTTPS or localhost — exported HTML opened via `file://` needs `document.execCommand('copy')` fallback
- The session being exported may contain its own source code (meta/self-referential sessions) — grep for script content must distinguish the actual `<script>` block from rendered code blocks in the DOM
- Summary dashboard uses `claude-sessions-dash-*` CSS classes for inner components. The outer container/header/chevron/copy-button classes (`claude-sessions-summary-*`) are unchanged — `standalone-player.ts` and `html-exporter.ts` reference them

## Live Watch / UI State

- Live reload re-renders the entire DOM — UI state (expanded tools, show-more, scroll position) must be captured before and restored after. Keyed by turn+block index, which is stable for append-only JSONL
- Progress bar dots must be reused in place (not destroyed/recreated) to avoid flicker during live reload. Diff the count: reposition existing, append new, remove excess
- Pending tool notifications must be deduped by tool ID (`lastNotifiedToolId`) — the live watcher fires `reloadSession()` on every file change, and the same pending tool persists until permission is granted

## Platform / Electron

- Electron `File` objects from drag-and-drop have a `.path` property with the absolute filesystem path. When unavailable, search configured session directories by filename as fallback
- Obsidian protocol handler params arrive as `Record<string, string>` from the query string; paths with special characters need `encodeURIComponent`/`decodeURIComponent`
- Session index cache uses `mtime` as staleness key — fast stat() check avoids re-reading unchanged files. Store in `.obsidian/plugins/claude-sessions/session-index.json` via direct `fs` (desktop-only)
- macOS ignores the `Notification.icon` property for the app icon (always shows Obsidian) but renders it as a secondary badge icon. SVG data URIs work

## Rendering

- All JSONL magic strings live in `constants.ts` — when Claude Code changes its schema, update one file. Parser logs unknown record/block type warnings with counts for format change detection
- ANSI rendering uses programmatic DOM construction (`buildAnsiDom()`) — no `innerHTML` anywhere in the renderer pipeline
- Image clipboard copy validates MIME type against `SAFE_IMAGE_TYPES` whitelist
- File picker normalizes drag-and-drop filenames with `path.basename()` to prevent path traversal
- MCP tool names follow `mcp__<server>__<tool>` — `parseMcpToolName()` splits on double underscores
- Tool result content arrays can contain image items alongside text items — images stored in `ToolResultBlock.images[]`
- Claude Code downscales images ~25x before embedding as base64 in JSONL. Original file path may be a temp file already cleaned up
- SVG ID remapping via `split().join()` for mermaid modals — duplicate IDs in DOM cause cloned SVG to inherit original's styles instead of its own
- `XMLSerializer` for SVG serialization — more correct than `outerHTML` for SVG elements
