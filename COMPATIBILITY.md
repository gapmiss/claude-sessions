# Claude Code compatibility

Which Claude Code versions changed the JSONL format in ways that matter to this plugin, and what the plugin does about each change.

**Latest Claude Code version seen: 2.1.280**

---

## Format changes

| Feature | CC version | Plugin version | Status | Notes |
| --- | --- | --- | --- | --- |
| Basic JSONL format | 1.0+ | 0.2.0+ | Stable | Core record types: user, assistant, progress |
| Token usage in messages | ~2.0+ | 0.2.0+ | Stable | `message.usage` with input, output, and cache tokens |
| Encrypted thinking | 2.1.79+ | 0.2.0+ | Stable | `thinking` is empty and the content is in `signature`. Skipped |
| Separate sub-agent JSONL | ~2.1.85? | 0.2.11+ | Stable | `subagents/agent-<id>.jsonl` files, each with a `.meta.json` |
| `tool_reference` blocks | ~2.1.88? | 0.2.12+ | Stable | ToolSearch results use these instead of text blocks |
| `hook_success` attachment | ~2.1.90? | 0.2.13+ | Stable | Hook runs with command, duration, and exit code. Feeds the HOOKS section and inline indicators |
| `skill_listing` attachment | ~2.1.90? | 0.2.13+ | Stable | Skills available in the session |
| `task_reminder` attachment | ~2.1.90? | 0.2.13+ | Stable | Background task counts |
| `permission-mode` records | ~2.1.90? | Unreleased | New | Permission mode, repeated up to ~100 times per session. No uuid or timestamp. Repeats are collapsed and each change is shown with the turn it applies from |
| `custom-title` records | ~2.1.90? | 0.2.13+ | Stable | The title set with `/rename`, in `customTitle` |
| `PermissionRequest` hook (`async_hook_response`) | 2.1.98 to 2.1.117 | 0.2.13+ | Stable | Shield icon on the tool call. Replaced in 2.1.214, still parsed for older sessions |
| `stop_hook_summary` system records | 2.0.42 to at least 2.1.282 | Unreleased | New | The only record of Stop hooks, written after nearly every turn. `hookInfos[]` (command, optional `durationMs`), `hookErrors[]`, `preventedContinuation`. Grouped by command in the HOOKS section |
| `pr-link` records | ~2.1.50? | 0.3.16+ | Skipped | PR number, URL, and repo. Nothing to render |
| `AskUserQuestion` option `preview` | ~2.1.92? | 0.3.16+ | Stable | A mockup or code sample per option, shown as a collapsible preformatted block |
| `agent-color` records | ~2.1.119? | 0.3.16+ | Skipped | Sibling of `agent-name`. Metadata only |
| `file-history-delta` records | ~2.1.214? | 0.3.16+ | Skipped | Per-file backup pointer, sibling of `file-history-snapshot` |
| `hook_permission_decision` attachment | 2.1.214+ | 0.3.22+ | New | Replaces `async_hook_response` for `PermissionRequest`. Carries `decision`, `toolUseID`, and `hookEvent`, but no stdout, duration, or command |
| `output_style` attachment | ~2.1.214? | 0.3.22+ | New | Active output style. On nearly every attachment record, but constant within a session |
| `command_permissions` attachment | ~2.1.214? | 0.3.22+ | New | Tools a slash command pre-approved with `allowed-tools`. Empty on about 99% of records |
| `read_truncation_notice` attachment | ~2.1.214? | 0.3.23+ | New | A Read result was cut short. Shown as a scissors icon on the tool call |
| `hook_blocking_error`, `hook_non_blocking_error` attachments | ~2.1.214? | 0.3.23+ | New | Hook failures, shown on the tool call. The non-blocking one also appears in HOOKS |
| `queued_command` attachment | ~2.1.214? | 0.3.23+ | New | A message sent mid-turn. `prompt` is a string, or an array of content blocks when images are attached. Shown inline in the turn |
| `atis-latch` records | ~2.1.214? | 0.3.23+ | Skipped | `atis` is always an empty string |
| `environment` attachment | ~2.1.270? | 0.3.25+ | Skipped | Working directory, platform, shell, OS. Already in session metadata |
| `model` attachment | ~2.1.270? | 0.3.25+ | Skipped | Model identity. Already in session metadata |
| `instructions` attachment | ~2.1.270? | 0.3.25+ | Skipped | CLAUDE.md contents. Already in the transcript as system-reminder tags |
| `session_context` attachment | ~2.1.270? | 0.3.25+ | Skipped | User email and git status. Already in the transcript as system-reminder tags |
| `date` attachment | ~2.1.270? | 0.3.25+ | Skipped | Current date. Already in the transcript as a system-reminder tag |
| `remote_session_change` attachment | ~2.1.270? | 0.3.25+ | Skipped | Commit and PR attribution config. Harness settings, not a session event |
| `prompt_snapshot` attachment | ~2.1.270? | 0.3.25+ | Skipped | The full system prompt. Already in the transcript as system-reminder tags |
| `deferred_tools_record` attachment | ~2.1.270? | 0.3.25+ | Skipped | Full schemas for deferred tools. Bookkeeping, like `deferred_tools_delta` |
| `silent_turn_reminder` attachment | ~2.1.280? | 0.3.26+ | Skipped | Tells the model to post a progress update after a long silence. Only the model sees it, and it holds no session data |

**Legend**

- `~`: approximate. We don't know exactly which version introduced it
- `?`: not yet verified
- Stable: confirmed working across several versions
- New: implemented recently, needs more testing
- Skipped: reviewed and deliberately not rendered

---

## Removed formats

| Feature | Removed in | Notes |
| --- | --- | --- |
| `hook_progress` in `progress` records | ~2.1.80? | Replaced by hook attachments (`hook_success` and related) |
| Inline `agent_progress` records | ~2.1.85? | Replaced by separate `subagents/*.jsonl` files. Still parsed for older sessions |
| `async_hook_response` for `PermissionRequest` | 2.1.214 | Replaced by `hook_permission_decision`. Last seen in 2.1.117. Both shapes are still parsed so older sessions keep working |

---

## Reviewed and skipped subtypes

These were examined and deliberately not rendered. The reasons live in `REVIEWED_ATTACHMENT_TYPES` and `REVIEWED_RECORD_TYPES` in `constants.ts`. Anything that isn't in those maps and isn't handled raises an `unknown_attachment_type` or `unknown_record_type` parse warning.

That warning is the early signal that Claude Code changed its format. It's what would have caught the 2.1.214 switch to `hook_permission_decision`. So never add an entry just to make the warning go away.

The test is: does the record carry something that appears nowhere else in the timeline and changes what a reader understands happened? If so, render it.

| Subtype | Fields | Why it's skipped |
| --- | --- | --- |
| `deferred_tools_delta` | `addedLines`, `addedNames`, `removedNames`, `readdedNames`, `pendingMcpServers` | Changes to the tool list. Doesn't affect what happened in the session |
| `agent_listing_delta` | `addedLines`, `addedTypes`, `removedTypes`, `isInitial`, `showConcurrencyNote` | Changes to the agent list. Actual agent runs appear as Agent tool calls |
| `total_tokens_reminder` | `text` | A context budget line added every turn. The numbers are already in the session stats |
| `compact_file_reference` | `displayPath`, `filename` | A path with no content. The file shows up through the tool call that read it |
| `already_read_file` | `content`, `displayPath`, `filename` | A cache hit (`content.type` is `file_unchanged`). The original read is already in the timeline |
| `directory` | `content`, `displayPath`, `path` | A listing from an @-mention. The same paths show up in the tool calls that follow |
| `plan_file_reference` | `planContent`, `planFilePath` | The plan is already shown through `plan_mode_exit` and the ExitPlanMode tool call |
| `companion_intro` | `name`, `species` | Cosmetic. Names the terminal companion |
| `atis-latch` (record) | `atis`, `sessionId` | `atis` is always an empty string |
| `cost-state` (record) | | Session totals. The summary already computes cost and tokens from each turn |

The 0.3.25 and 0.3.26 additions are listed in the format changes table above, and the full list is in `constants.ts`.

---

## Updating this document

When you add support for a new format change:

1. Check your Claude Code version with `claude --version`
2. Add a row to the format changes table with the feature, your Claude Code version (prefix `~` if you don't know when it first appeared), the plugin version that handles it, and a status. Start at New and move to Stable once it has held up across versions
3. If you add a test fixture, note the Claude Code version in a comment:
   ```typescript
   /** PermissionRequest hook decision attachment (CC 2.1.214+). */
   export function hookPermissionDecision(...) { }
   ```
4. Test against older sessions if you can, to confirm nothing broke

---

## Version detection

The plugin doesn't change behavior based on the Claude Code version. Each session records it in the `version` field (for example `"2.1.280"`), and the summary panel displays it. It could be used later to enable features or explain warnings per version.

---

## Reporting a format change

If the plugin doesn't handle something in your sessions:

1. Note your Claude Code version (`claude --version`)
2. Look for parse warnings in the session summary panel, or "unknown record type", "unknown block type", and "unknown attachment type" in the developer console
3. Open an issue with the Claude Code version, a sample JSONL record (remove anything sensitive), and what you expected to see
