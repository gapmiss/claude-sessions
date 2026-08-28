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

## Unhandled Attachment Subtypes

Attachment subtypes seen in real sessions that the plugin parses past without
rendering. Anything not listed here and not handled raises an
`unknown_attachment_type` parse warning — that warning is the early signal for a
Claude Code format change, so this list should be kept current.

| Subtype | Fields | Notes |
|---------|--------|-------|
| `deferred_tools_delta` | `addedLines`, `addedNames`, `removedNames`, `readdedNames`, `pendingMcpServers` | Tool availability churn |
| `agent_listing_delta` | `addedLines`, `addedTypes`, `removedTypes`, `isInitial`, `showConcurrencyNote` | Sub-agent availability churn |
| `file` | `content`, `displayPath`, `filename` | User-attached file contents |
| `edited_text_file` | `filename`, `snippet` | External IDE edit |
| `diagnostics` | `files`, `isNew` | LSP diagnostics surfaced to Claude |
| `queued_command` | `commandMode`, `prompt` | Input typed while Claude was working |
| `plan_mode`, `plan_mode_exit` | `planExists`, `planFilePath`, `reminderType`, `isSubAgent` | Plan mode transitions |
| `invoked_skills` | `skills` | Which skill ran |
| `compact_file_reference`, `already_read_file`, `directory`, `plan_file_reference` | `displayPath`, `filename`, `content` | File references, largely redundant with the tool calls that produced them |
| `read_truncation_notice` | `banner`, `toolUseID` | Explains a truncated Read result; has a `toolUseID`, so it belongs inline on the tool block |
| `hook_blocking_error`, `hook_non_blocking_error` | `hookName`, `hookEvent`, `toolUseID`, plus `command`/`stdout`/`stderr`/`exitCode`/`durationMs` on the non-blocking variant | Hook failures; `hook_non_blocking_error` matches the `hook_success` field set |
| `companion_intro` | `name`, `species` | Cosmetic |

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
