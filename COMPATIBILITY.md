# Claude Code Compatibility

This document tracks which Claude Code versions introduced JSONL format changes that affect this plugin.

**Current Claude Code version being tested against: 2.1.92**

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

**Legend:**
- `~` = Approximate version (not confirmed exactly when introduced)
- `?` = Needs verification
- Stable = Confirmed working across multiple versions
- New = Recently implemented, needs broader testing

---

## Deprecated/Removed Formats

| Feature | Removed In | Notes |
|---------|------------|-------|
| `hook_progress` in progress records | ~2.1.80? | Replaced by `system` records with `stop_hook_summary` |
| Inline `agent_progress` records | ~2.1.85? | Replaced by separate `subagents/*.jsonl` files |

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
