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
- Pinned heroes use negative margins to break out of the content max-width — requires `overflow-x: hidden` on `.claude-sessions-timeline` to prevent horizontal scrollbar
- `refreshSummary()` destroys and rebuilds the pinned heroes and summary DOM — must capture `is-pinned` and `open` state before teardown and restore after re-render, otherwise live reload resets pin state
- Progress bar tooltip (`top: -24px`) is clipped by parent `overflow: hidden` — the progress wrap needs enough top padding (28px) to contain it within bounds

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
- Hook records changed format: old `progress` records with `data.type: "hook_progress"` are dead. Hooks now emit `system` records with `subtype: "stop_hook_summary"` containing `hookInfos[]` with `command` fields
- Hook events can be turn-level (after assistant response) or tool-level (with `toolUseId`). Tool-level events are shown inline with the tool call; turn-level events go in the System Events panel
- `PermissionRequest` hook events indicate permission was requested for a tool call — rendered as shield icon in tool header
- Sessions often start with multiple 6KB+ `file-history-snapshot` records — reading only the first 2KB misses all metadata. Use line-by-line reading with prefix-skip for large record types instead
- `agent_progress` records are the legacy format — newer Claude Code versions no longer emit them. All sub-agent data now lives in separate `subagents/agent-<id>.jsonl` files alongside `.meta.json` files
- Subagent JSONL files mark every record as `isSidechain: true` — parser needs `allowSidechain: true`
- Background agents don't produce `agent_progress` records at all. Their completion arrives as `<task-notification>` XML in `queue-operation` or `user` records, which must be captured before those record types are skipped
- Foreground Explore and worktree agents don't include `agentId` in their tool_result text. Resolution requires scanning `subagents/*.meta.json` and matching by description field
- General-purpose and background agents include `agentId: <id>` in a tool_result text block — extracted via `RE_AGENT_ID` regex
- The `Task` tool name is legacy (replaced by `Agent`) but kept in `SUBAGENT_TOOL_NAMES` for backward compatibility with older session files
- `ToolSearch` tool results use `tool_reference` content blocks (`{"type":"tool_reference","tool_name":"..."}`) instead of standard text blocks — the parser must extract `tool_name` or the result appears empty
- `ToolSearch` structured data (matches, query, total_deferred_tools) is available via `toolUseResult` on the user record, captured as `enrichedResult` on the `ToolResultBlock`
- Session directory encoding (`-Users-gm-claude-sessions`) is lossy — hyphens in directory names are indistinguishable from path separators. Prefer `cwd` from session metadata; `extractProjectName()` is fallback only
- Custom session titles from `/rename` command are stored as `<custom-title>text</custom-title>` XML in a user record. Parser captures into `metadata.customTitle`
- `ToolSearch` results use `tool_reference` content blocks (`{"type":"tool_reference","tool_name":"..."}`) instead of text blocks — must extract `tool_name` or result appears empty
- System events (hooks, skills, task reminders) are captured during first pass but rendered after summary panel, not with turns — they provide session-level context
- Session duration must use **active time**, not wall-clock (`lastTimestamp - firstTimestamp`). Resumed sessions can span days/weeks of idle time. Calculate by summing turn durations + gaps ≤ 30 minutes, excluding larger gaps as session breaks

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
- Markdown code/preview toggles (`renderMarkdownToggle`) must render preview eagerly — lazy rendering leaves the preview div empty in HTML export DOM snapshots. The standalone player handles the toggle via delegated click on `.claude-sessions-read-md-btn`

## Search

- BM25 is used only for ranking, not for finding matches — exact substring matching is the source of truth. Earlier approach using BM25 for candidate discovery produced false positives from scattered stemmed terms (e.g., "rate limit fetcher" matching any doc containing "rate", "limit", or "fetch" separately)
- Cross-session search must resolve `approxTurnIndex` (a role-transition counter from line scanning) to actual turn index via `resolveMatchTurn()` using timestamps. In-session search already did this correctly
- `expandAncestors()` must handle all collapsible element types: tool blocks, tool groups, thinking blocks, show-more wraps (`.claude-sessions-collapsible-toggle`, NOT `.claude-sessions-show-more-btn`), sub-agent prompts, slash command blocks, compaction summaries, and markdown preview toggles
- When the pinned dashboard is visible, turns need `scroll-margin-top` (CSS sibling combinator on `.is-pinned`) to prevent `scrollIntoView` from placing content behind the sticky bar
- Multiple occurrences of the same query in a turn require `matchContext` (trailing chars of `contextBefore`) for disambiguation — without it, highlighting always lands on the first occurrence

## Live Watch / UI State

- Live reload re-renders the entire DOM — UI state (expanded tools, show-more, scroll position) must be captured before and restored after. Keyed by turn+block index, which is stable for append-only JSONL
- Progress bar dots must be reused in place (not destroyed/recreated) to avoid flicker during live reload. Diff the count: reposition existing, append new, remove excess
- Pending tool notifications must be deduped by tool ID (`lastNotifiedToolId`) — the live watcher fires `reloadSession()` on every file change, and the same pending tool persists until permission is granted

## Platform / Electron

- Electron `File` objects from drag-and-drop have a `.path` property with the absolute filesystem path. When unavailable, search configured session directories by filename as fallback
- Obsidian protocol handler params arrive as `Record<string, string>` from the query string; paths with special characters need `encodeURIComponent`/`decodeURIComponent`
- Session index cache uses `mtime` as staleness key — fast stat() check avoids re-reading unchanged files. Store in `.obsidian/plugins/claude-sessions/session-index.json` via direct `fs` (desktop-only)
- macOS ignores the `Notification.icon` property for the app icon (always shows Obsidian) but renders it as a secondary badge icon. SVG data URIs work
- Claude OAuth credentials on macOS are stored in Keychain (`security find-generic-password -s "Claude Code-credentials" -w`), not in `~/.claude/.credentials.json`. The file is the Linux/fallback path. Both contain `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`
- `api.anthropic.com/api/oauth/usage` is an undocumented beta endpoint (header `anthropic-beta: oauth-2025-04-20`). Returns `five_hour`, `seven_day` utilization percentages and `resets_at` timestamps. May break without notice

## Distill

- Layer 0 extraction is zero-LLM-cost — frontmatter values come directly from session stats; `session_type` classification requires LLM and is only populated via [`/distill`](./skills/distill/SKILL.md) skill merge
- Distill note names use `{project}-{session_id_prefix}.md` format — the session_id prefix (first 8 chars) ensures uniqueness while keeping names readable
- Merge logic preserves user-written content: only frontmatter and auto-generated section headers are updated; body text under headers is kept
- `files_touched` is deduplicated and sorted — extracted from Edit/Write/Read tool inputs, relative to cwd when possible
- `obsidian_uri` encodes the full session path for protocol handler linking — special characters must be URI-encoded
- Bases templates use `.base` extension (Obsidian Bases format) — requires Obsidian 1.8+ with Bases feature enabled
- Template formulas like `cost_display` use Bases expression syntax, not JavaScript — see Obsidian Bases docs
- **Adding a frontmatter field requires FOUR file updates**: `types.ts` (interface), `extract-frontmatter.ts` (extraction), `serialize-frontmatter.ts` (primary serialization), and `build-note.ts` `orderedKeys` + section-end logic (merge serialization). Missing any one causes silent field omission or misordering
- Merge serializer (`serializeMergedFrontmatter`) has its own `orderedKeys` array separate from the primary `serializeFrontmatter` — both must be updated when adding fields

## Rendering

- ANSI escape code regexes must use `String.fromCharCode(0x1b)` instead of literal `\x1b` — the Obsidian community plugin scanner flags control characters in source code
- All JSONL magic strings live in `constants.ts` — when Claude Code changes its schema, update one file. Parser logs unknown record/block type warnings with counts for format change detection
- ANSI rendering uses programmatic DOM construction (`buildAnsiDom()`) — no `innerHTML` anywhere in the renderer pipeline
- Image clipboard copy validates MIME type against `SAFE_IMAGE_TYPES` whitelist
- File picker normalizes drag-and-drop filenames with `path.basename()` to prevent path traversal
- MCP tool names follow `mcp__<server>__<tool>` — `parseMcpToolName()` splits on double underscores
- Tool result content arrays can contain image items alongside text items — images stored in `ToolResultBlock.images[]`
- Claude Code downscales images ~25x before embedding as base64 in JSONL. Original file path may be a temp file already cleaned up
- SVG ID remapping via `split().join()` for mermaid modals — duplicate IDs in DOM cause cloned SVG to inherit original's styles instead of its own
- `XMLSerializer` for SVG serialization — more correct than `outerHTML` for SVG elements

## Public API

- The API is accessed via `app.plugins.plugins['claude-sessions']?.api` — plugin may not be loaded, always check for undefined
- `onSessionParsed` callback fires on both initial load and live-watch reloads — dedupe if needed
- `parseSessionFile()` does NOT resolve sub-agents — call `resolveSubAgentSessions()` separately if sub-agent data is needed
- Session index entries are lightweight metadata (no full parse) — use `parseSessionFile()` for full Session object
- API surface is designed to be stable: additions are non-breaking, removals require major version bump
