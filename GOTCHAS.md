# Gotchas

Pitfalls we've already hit, so nobody has to hit them twice. It isn't loaded into Claude's context automatically. Reference it with `@GOTCHAS.md` when you're working somewhere unfamiliar.

## Obsidian API

- `FuzzySuggestModal.getItems()` is synchronous, so async data has to be loaded before `.open()`. The session browser uses `SuggestModal`, whose `getSuggestions()` may return a promise
- Dispatching a synthetic `input` event on a modal's `inputEl` recurses forever through Obsidian's `onInput`
- `WorkspaceLeaf.updateHeader()` isn't in the type definitions, so cast through `unknown`. It updates the tab title but not reliably the view header, so set `.view-header-title` text directly as well
- `Component` has no `.app`. Pass `App` to the renderer separately
- With `isolatedModules`, interfaces need `export type`
- Don't call `detachLeavesOfType()` in `onunload`. It resets the leaf's position when the plugin reloads
- TypeScript's DOM types give `StyleSheetList` and `CSSRuleList` no iterator. Wrap them in `Array.from()` before `for...of`

## Obsidian CSS

- `--color-cyan`, `--color-blue`, `--color-red`, and `--color-green` follow the theme, so use them for tool indicators and diffs
- Obsidian renders mermaid as `div.mermaid`, not `.block-language-mermaid`
- The pinned hero bar uses negative margins to break out of the content width. That needs `overflow-x: hidden` on `.claude-sessions-timeline`, or a horizontal scrollbar appears
- `refreshSummary()` tears down and rebuilds the hero bar and summary. Save `is-pinned` and `open` before and restore them after, or every live reload unpins the bar
- The progress bar tooltip sits at `top: -24px` and gets clipped by the parent's `overflow: hidden`. The wrapper needs 28px of top padding to keep it visible
- Some themes never define `--text-highlight-bg`. Anything that uses it needs a fallback (search marks fall back through `--color-yellow`)

## ESLint

- `eslint-plugin-obsidianmd` exports its recommended config as a flat object of rules, not under a `rules` key. Spread it into `rules` yourself for ESLint 9 flat config
- The type-aware rules need `@typescript-eslint/parser` with `parserOptions.project`

## Claude Code JSONL format

### Records and tokens

- Each assistant content block (thinking, text, tool_use) is its **own JSONL record** with its own uuid. Merge consecutive assistant records, or tool results end up with nothing to attach to
- Streaming writes several records with the same uuid. Keep the last one, which is the most complete
- `input_tokens` is usually tiny because caching covers most input. The real input is in `cache_read_input_tokens` and `cache_creation_input_tokens`
- Streaming also repeats usage for the same message, with only `output_tokens` growing. Deduplicate by message ID, keep the max of each field, then sum across messages. When `message.id` is missing, fall back to `record.uuid`, then to a counter (`__anon_N`), so nothing is silently dropped
- Since Claude Code 2.1.79 thinking is encrypted: `thinking` is empty and the content is in `signature`. The parser skips these
- Session duration means **active time**, not last timestamp minus first. A resumed session can span weeks. Add up turn durations plus gaps of 30 minutes or less, and treat longer gaps as breaks
- The session directory name (`-Users-gm-claude-sessions`) can't be decoded reliably, because hyphens in folder names look like path separators. Use `cwd` from the session metadata. `extractProjectName()` is only a fallback
- Custom titles from `/rename` arrive as a `custom-title` record with a `customTitle` field. The last one wins

### New and unknown types

- Claude Code keeps adding metadata-only record types (`mode`, `ai-title`, `agent-name`, `agent-color`, `file-history-delta`, `pr-link`, and more). Anything not in `SKIP_RECORD_TYPES` or `REVIEWED_RECORD_TYPES` raises "unknown record type"
- When one appears, check the whole corpus rather than just the session that reported it. `grep -rho '"type":"[a-z-]*"' ~/.claude/projects | sort -u` usually finds several at once. It also picks up nested content-block and tool-input `type` fields, so compare it against the known record types instead of reading it raw. New skip types go in **both** `SKIP_RECORD_TYPES` and `SKIP_TYPE_STRINGS`; the second keeps them out of search and streaming
- Unknown **attachment** subtypes used to be dropped silently while unknown *record* types warned. That hid the `hook_permission_decision` change: every permission approval disappeared from the timeline and nothing said so. Unknown attachment subtypes now raise `unknown_attachment_type`. Keep the table in COMPATIBILITY.md current so the warning stays meaningful
- The warning only helps if it stays quiet on healthy sessions, and it's only trustworthy if silencing a subtype takes a reason. That's why `REVIEWED_ATTACHMENT_TYPES` and `REVIEWED_RECORD_TYPES` are maps, not sets. A good entry says what the record holds and why the reader doesn't need it. "Seen often" isn't a reason: `companion_intro` shows up once and is cosmetic, while `read_truncation_notice` shows up five times and explains why a tool result is incomplete
- Field names mislead both ways. `directory` sounds like a path but holds a full listing. `already_read_file` sounds like file content, but its `content.type` is `file_unchanged` with no text. `edited_text_file` sounds like an edit in an IDE but fires for any change on disk, including one made by a Bash command in the same session. Look at real values before deciding what a subtype means: grep `'"type": *"attachment"'` in `~/.claude/projects/`, group by `attachment.type`, and keep one sample of each

### Attachments

- `output_style` and `command_permissions` repeat constantly (about 6,000 and 270 records in one working vault), but they don't change within a session, and `command_permissions.allowedTools` is empty about 99% of the time. Collapse the repeats in the parser, not the renderer, and track the last value in a local variable. Filtering the growing `systemEvents` array on every record is O(n²) at these counts
- A slash command's `allowed-tools` grant lands several attachment records below the user record with `<command-name>`. Finding the command that asked means walking the `parentUuid` chain, the same way `async_hook_response` finds its tool
- A message sent while Claude is working exists **only** as a `queued_command` attachment. Claude Code writes no user record for it, so dropping the attachment loses the message. `prompt` is a string, or an array of content blocks when images are attached. Two other things share the subtype: `<task-notification>` XML (background agent results, rendered from their own records) and, now and then, a message Claude Code also delivered as a normal prompt. Deduplicate that second case by equality or prefix, never containment, or a short prompt like `npx eslint .` matches any later message that quotes it

### Hooks

- Hooks were once `progress` records with `data.type: "hook_progress"`. Those are gone. Hooks now arrive as attachments (`hook_success`, `async_hook_response`, `hook_permission_decision`, `hook_blocking_error`, `hook_non_blocking_error`)
- A hook event either belongs to a tool call or to the turn. Tool events show on the tool call; turn events go in the System events panel. Having a `toolUseID` isn't enough: a `Stop` hook carries one that names no tool call. Check that the id matches a real tool call
- `PermissionRequest` changed shape in Claude Code 2.1.214. From 2.1.98 to 2.1.117 it was an `async_hook_response` attachment with `hookName: "PermissionRequest:<Tool>"`. Now it's a `hook_permission_decision` attachment with `decision` and an authoritative `toolUseID`. The parser reads both. The new one has no stdout, duration, or command, so it only drives the header icon

### Sub-agents

- `agent_progress` records are the legacy format. Newer Claude Code writes sub-agents to `subagents/agent-<id>.jsonl` with a `.meta.json` beside each
- Every record in a sub-agent file has `isSidechain: true`, so the parser needs `allowSidechain: true`
- Background agents write no `agent_progress` at all. Their result arrives as `<task-notification>` XML in `queue-operation` or `user` records, which must be captured before those types are skipped
- Foreground Explore and worktree agents don't put `agentId` in their tool result text. Match them by scanning `subagents/*.meta.json` for the same description
- General-purpose and background agents do include `agentId: <id>` in a tool result text block, which `RE_AGENT_ID` extracts
- `Task` is the old name for the `Agent` tool. It stays in `SUBAGENT_TOOL_NAMES` so older sessions still work

### Tool results

- `ToolSearch` results are `tool_reference` blocks (`{"type":"tool_reference","tool_name":"..."}`), not text. Pull out `tool_name`, or the result looks empty. The structured data (matches, query, total_deferred_tools) is in the record's `toolUseResult`, captured as `enrichedResult`
- Tool result content can mix images and text. Images go in `ToolResultBlock.images[]`
- Claude Code shrinks images roughly 25x before embedding them as base64. The original path is often a temp file that no longer exists

## Slash commands and skills

- Skill and custom commands look like `<command-message>plugin:cmd</command-message>\n<command-name>/plugin:cmd</command-name>`. Built-in commands have no `<command-message>`
- `/wrap:wrap` displays as `/wrap`. `RE_SLASH_COMMAND` allows `[\w:./-]+` in its capture group
- After a skill command, `isMeta` user records with array content hold the expanded prompt. The first pass has to let `isMeta` user records through so the second pass can use them
- A slash command's `allowed-tools` grant **can't** override a `deny` rule in `settings.json`. From Anthropic's permissions docs: "Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome, and rule specificity doesn't change the order," and "If a tool is denied at any level, no other level can allow it." So a `Read(~/.ssh/**)` deny really does protect against `/statusline`'s `Read(~/**)` grant. It has limits:
  - Deny covers Claude's file tools, the Bash file commands Claude Code recognizes (`cat`, `head`, `tail`, `sed`), and redirect targets. It does **not** cover a subprocess that opens files itself, like a Python script. Only the sandbox stops that
  - In *user* settings a bare relative path resolves against `~/.claude`, so write `~/` or `//` absolute paths
  - A `Read` deny also blocks Edit and Write on the same path, but not NotebookEdit

## Export

- Both exporters take `ExportOptions` from the modal. The toggles (`exportIncludeSummary`, `exportIncludeSystemEvents`) persist in settings
- HTML export removes the `.claude-sessions-summary` and `.claude-sessions-system-events` panels when they're off. Markdown export skips those sections
- Markdown export has its own renderer per tool. A new tool type without one falls back to raw JSON, so add it to `renderToolUse()`
- New fields in `SessionStats` need adding to the frontmatter in `buildMarkdown()` too

### HTML export

- Collapsibles must toggle `open` and `collapsed`. Setting `display` directly fights the CSS
- Live copy buttons capture their text in closures, which don't survive serialization. The export copies the text into `data-copy-text`
- `navigator.clipboard.writeText()` needs HTTPS or localhost. A file opened from `file://` falls back to `document.execCommand('copy')`
- A session can contain the plugin's own source code. When checking the export's script, tell the real `<script>` block apart from code blocks rendered in the timeline
- Dashboard internals use `claude-sessions-dash-*`. The outer container, header, chevron, and copy button keep `claude-sessions-summary-*`, which `standalone-player.ts` and `html-exporter.ts` depend on
- Markdown code/preview toggles (`renderMarkdownToggle`) must render the preview up front. If it's lazy, the snapshot captures an empty div. The standalone player handles the toggle with a delegated click on `.claude-sessions-read-md-btn`

## Search

- Matches come from exact substring search. BM25 only ranks them. Using BM25 to find candidates gave false positives from scattered stemmed words: "rate limit fetcher" matched anything containing "rate", "limit", or "fetch"
- Cross-session search counts turns roughly while scanning lines (`approxTurnIndex`). `resolveMatchTurn()` maps that to the real turn by timestamp. In-session search already had the real index
- `expandAncestors()` must handle every collapsible: tool blocks, tool groups, thinking, show-more wraps (`.claude-sessions-collapsible-toggle`, **not** `.claude-sessions-show-more-btn`), sub-agent prompts, slash commands, compaction summaries, and Markdown toggles
- With the pinned bar showing, turns need `scroll-margin-top` (a sibling selector on `.is-pinned`), or `scrollIntoView` puts the match behind the bar
- When a query appears more than once in a turn, `matchContext` (the end of `contextBefore`) picks the right one. Without it the highlight always lands on the first
- Tool INPUT sections carry `data-content-block-idx` for highlighting. The attribute has to be on the element holding the searchable text, not a preview span in the collapsed header. `renderBashInput`, `renderDiffView`, `renderWriteView`, `renderWebFetchInput`, and the generic input all set it
- `RE_EDIT_WRITE_SUCCESS` keeps "The file X has been updated/created successfully" out of the index. Those messages aren't displayed (the diff is), so matching them would lead nowhere
- Cross-session search reads raw JSONL, so it has to handle every record shape that holds user-visible text on its own. Mid-turn messages (`queued_command` attachments) were missed for a release because of this

## Live watch and UI state

- Live reload redraws the whole DOM. Save UI state (expanded tools, show-more, scroll) first and restore it after. Key it by turn and block index, which stays stable because the file only grows
- Reuse progress bar dots instead of recreating them, or they flicker on reload. Reposition the existing ones, add new ones, remove extras
- Deduplicate pending tool notifications by tool ID (`lastNotifiedToolId`). The watcher reloads on every change, and the same pending tool sticks around until permission is granted

## Platform and Electron

- Files dropped from the OS have a `.path` with the absolute path. When it's missing, look for the filename in the configured session directories
- Protocol handler params arrive as `Record<string, string>`. Paths with special characters need `encodeURIComponent` and `decodeURIComponent`
- The session index uses `mtime` to spot stale entries, so unchanged files only cost a `stat()`. It's stored at `.obsidian/plugins/claude-sessions/session-index.json` using `fs` directly (desktop only)
- macOS ignores `Notification.icon` for the app icon (it's always Obsidian's) but shows it as a small badge. SVG data URIs work
- On macOS, Claude's OAuth credentials live in the Keychain (`security find-generic-password -s "Claude Code-credentials" -w`), not `~/.claude/.credentials.json`. The file is used on Linux and as a fallback. Both hold `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`
- `api.anthropic.com/api/oauth/usage` is an undocumented beta endpoint (header `anthropic-beta: oauth-2025-04-20`). It returns `five_hour` and `seven_day` percentages with `resets_at` times, and could change without notice

## Distill

- Distilling costs nothing: frontmatter comes straight from session stats. Only `session_type` needs an LLM, and it only arrives through a [`/distill`](./skills/distill/SKILL.md) merge
- Notes are named `{project}--{YYYY-MM-DD}--{short-id}.md`, where the short ID is the first 8 characters of the session ID
- A plain distill writes frontmatter and a Stats table. Distilling again replaces the note, unless it has a `## Summary` (it was merged with `/distill` output). Then the body is kept and only the frontmatter is refreshed. Text a user adds to a note that was never merged gets overwritten
- `files_touched` comes from Read, Edit, and Write inputs, relative to cwd when possible, deduplicated and sorted
- `obsidian_uri` encodes the full session path, so special characters must be URI-encoded
- Bases templates are `.base` files and need the Bases core plugin. Formulas like `cost_display` use Bases expression syntax, not JavaScript
- **A new frontmatter field needs four changes**: the interface in `types.ts`, extraction in `extract-frontmatter.ts`, `serializeFrontmatter` in `serialize-frontmatter.ts`, and the `orderedKeys` array and section-end logic in `build-note.ts`. The merge serializer (`serializeMergedFrontmatter`) keeps its own `orderedKeys`. Miss one and the field silently disappears or lands out of order

## Rendering

- ANSI regexes must build the escape character with `String.fromCharCode(0x1b)`. The community scanner flags a literal `\x1b` as a control character
- A text block starting with `---` gets eaten by `MarkdownRenderer` as YAML frontmatter. Everything up to the next `---` disappears, and the turn renders blank while "Show more (N lines)" still counts the raw lines. `normalizeMarkdown()` rewrites a leading `---` to `***`. Every `MarkdownRenderer.render()` call on model-written text must go through it
- `AskUserQuestion` option previews come in three forms: bare ASCII, fully fenced, and (most often) fenced art followed by prose. They render preformatted, because a Markdown pass collapses the whitespace ASCII mockups rely on. `stripFenceMarkers()` drops lines that are *only* a fence, which handles all three. Art like `~~~~~~~~~ <- dirt mound` survives because the annotation stops it being a bare fence line
- Mermaid modals remap SVG IDs with `split().join()`. Duplicate IDs make the copy pick up the original's styles
- Serialize SVG with `XMLSerializer`. It's more correct than `outerHTML` for SVG

## Public API

- Other plugins reach it at `app.plugins.plugins['claude-sessions']?.api`. The plugin might not be loaded, so check for undefined
- `onSessionParsed` fires on the first load and on every live reload. Deduplicate if that matters
- `parseSessionFile()` doesn't resolve sub-agents. The resolver (`resolveSubAgentSessions()`) isn't part of the API
- Index entries are light metadata without a full parse. Use `parseSessionFile()` for the whole Session
- The API is meant to stay stable: additions are fine, removals need a major version
