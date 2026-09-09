# Claude Code Compatibility

This document tracks which Claude Code versions introduced JSONL format changes that affect this plugin.

**Current Claude Code version being tested against: 2.1.214**

---

## JSONL Format Evolution

| Feature | CC Version | Plugin Version | Status | Notes |
|---------|------------|----------------|--------|-------|
| Basic JSONL format | 1.0+ | 0.2.0+ | Stable | Core record types: user, assistant, progress |
| Token usage in message | ~2.0+ | 0.2.0+ | Stable | `message.usage` with input/output/cache tokens |
| Encrypted thinking | 2.1.79+ | 0.2.0+ | Stable | `thinking` field empty, content in `signature` |
| Separate subagent JSONL | ~2.1.85? | 0.2.11+ | Stable | `subagents/agent-<id>.jsonl` files alongside `.meta.json` |
| `tool_reference` blocks | ~2.1.88? | 0.2.12+ | Stable | ToolSearch results use this instead of text blocks |
| System events (`stop_hook_summary`) | ~2.1.90? | 0.2.13+ | New | Hook events with `hookInfos[]` array |
| System events (`skill_listing`) | ~2.1.90? | 0.2.13+ | New | Available skills in `system` records |
| System events (`task_reminder`) | ~2.1.90? | 0.2.13+ | New | Task tool reminders |
| Custom titles (`/rename`) | ~2.1.90? | 0.2.13+ | New | `<custom-title>` XML in user records |
| `PermissionRequest` hook event | 2.1.92+ | 0.2.13+ | New | Tool-level permission request indicators |
| `pr-link` records | ~2.1.50? | 0.3.16+ | Skipped | PR number/URL/repo metadata, no renderable content |
| `AskUserQuestion` option `preview` | ~2.1.92? | 0.3.16+ | New | Per-option mockup/code sample; rendered as collapsible preformatted block |
| `agent-color` records | ~2.1.119? | 0.3.16+ | Skipped | Sibling of `agent-name`, metadata only |
| `file-history-delta` records | ~2.1.214? | 0.3.16+ | Skipped | Per-file backup pointer, sibling of `file-history-snapshot` |
| `hook_permission_decision` attachment | 2.1.214+ | 0.3.22+ | New | Replaced `async_hook_response` for `PermissionRequest` outcomes. Carries `decision`, `toolUseID`, `hookEvent` — no stdout, duration, or command |
| `output_style` attachment | ~2.1.214? | 0.3.22+ | New | Active output style, stamped on nearly every attachment record; value is session-constant |
| `command_permissions` attachment | ~2.1.214? | 0.3.22+ | New | Slash command `allowed-tools` grant. Empty on ~99% of records |
| `read_truncation_notice` attachment | ~2.1.214? | 0.3.23+ | New | Read output cut short. Renders as an inline indicator on the tool block via `toolUseID` |
| `hook_blocking_error`, `hook_non_blocking_error` attachments | ~2.1.214? | 0.3.23+ | New | Hook failures. Inline indicator via `toolUseID`; the non-blocking variant also lands in the HOOKS section |
| `queued_command` attachment | ~2.1.214? | 0.3.23+ | New | A message sent mid-turn. `prompt` is a string or an array of content blocks when images are attached. Renders inline in the turn |
| `atis-latch` records | ~2.1.214? | 0.3.23+ | Skipped | `atis` is always an empty string |

**Legend:**
- `~` = Approximate version (not confirmed exactly when introduced)
- `?` = Needs verification
- Stable = Confirmed working across multiple versions
- New = Recently implemented, needs broader testing
- Skipped = Metadata-only record, filtered out rather than rendered

---

## Deprecated/Removed Formats

| Feature | Removed In | Notes |
|---------|------------|-------|
| `hook_progress` in progress records | ~2.1.80? | Replaced by `system` records with `stop_hook_summary` |
| Inline `agent_progress` records | ~2.1.85? | Replaced by separate `subagents/*.jsonl` files |
| `async_hook_response` for `PermissionRequest` | 2.1.214 | Replaced by the `hook_permission_decision` attachment. Last seen in 2.1.117; both shapes are still parsed so older sessions keep rendering |

---

## Reviewed and Skipped Subtypes

Subtypes examined and deliberately not rendered. The reasons live in
`REVIEWED_ATTACHMENT_TYPES` and `REVIEWED_RECORD_TYPES` in `constants.ts`;
anything absent from those maps and not handled raises an
`unknown_attachment_type` or `unknown_record_type` parse warning. That warning is
the early signal for a Claude Code format change — it is what would have caught
the 2.1.214 `hook_permission_decision` switch — so never add an entry just to
silence noise.

The criterion: does the record carry information that appears nowhere else in
the timeline and changes what a reader understands happened? If yes, render it.

| Subtype | Fields | Why it is skipped |
|---------|--------|-------------------|
| `deferred_tools_delta` | `addedLines`, `addedNames`, `removedNames`, `readdedNames`, `pendingMcpServers` | Tool-schema churn, no bearing on what happened in the session |
| `agent_listing_delta` | `addedLines`, `addedTypes`, `removedTypes`, `isInitial`, `showConcurrencyNote` | Available-agent churn; actual agent runs appear as Agent tool calls |
| `total_tokens_reminder` | `text` | Context-budget banner injected each turn; the counts are already in session stats |
| `compact_file_reference` | `displayPath`, `filename` | Path only, no content; the file is visible via the tool call that read it |
| `already_read_file` | `content`, `displayPath`, `filename` | Cache-hit marker (`content.type` is `file_unchanged`); the original read is already in the timeline |
| `directory` | `content`, `displayPath`, `path` | Directory listing from an @-mention; the same paths surface through the tool calls that follow |
| `plan_file_reference` | `planContent`, `planFilePath` | Plan text is already rendered via `plan_mode_exit` and the ExitPlanMode tool call |
| `companion_intro` | `name`, `species` | Cosmetic — names the terminal companion |
| `atis-latch` (record) | `atis`, `sessionId` | `atis` is always an empty string |

---

## How to Update This Document

When implementing support for a new JSONL feature:

1. **Check your Claude Code version**
   ```bash
   claude --version
   ```

2. **Add a row to the table above** with:
   - Feature name
   - Your current CC version (use `~` prefix if you're not sure when it was introduced)
   - Plugin version that adds support
   - Status: `New` initially, change to `Stable` after confirmed across versions

3. **Update test fixtures** if applicable — add a comment noting the CC version:
   ```typescript
   /** System event record. CC 2.1.90+ */
   export function systemHookEvent(...) { }
   ```

4. **Test with older sessions** if possible to determine backwards compatibility

---

## Version Detection

The plugin currently does not detect Claude Code version from session files. Session metadata includes:
- `version` field (Claude Code version string, e.g., "2.1.92")

Future enhancement: Use this to conditionally enable/disable features or show compatibility warnings.

---

## Reporting Format Changes

If you encounter a JSONL format that the plugin doesn't handle:

1. Note your Claude Code version (`claude --version`)
2. Check the console for "Unknown record type" or "Unknown block type" warnings
3. Open an issue with:
   - CC version
   - Sample JSONL record (redact sensitive content)
   - Expected behavior

The parser logs unknown types with counts to help detect format changes early.
