---
name: distill
description: Distills the current Claude Code session into a structured Obsidian note with queryable YAML frontmatter. Use when the user wants to capture, summarize, or archive a coding session — e.g. at the end of a session, when wrapping up work, when asked to save session notes, or when using the /distill command. Produces a markdown file with session metadata, decisions, learnings, and key exchanges.
---

# /distill — Live Session Distillation

Distill the current Claude Code session into a structured Obsidian note with queryable frontmatter.

## Workflow

1. **Gather metadata** — collect session_id, cwd, git branch, model, start time, token counts, cost, tool usage, and files touched from the environment and session context.
2. **Classify session type** — review the conversation and assign one or more types from the vocabulary below.
3. **Synthesize content** — extract key decisions (with reasoning), non-obvious learnings, and the most important exchanges from the full conversation.
4. **Write output** — produce the markdown file to stdout using the exact structure below, then name it per the naming convention.
5. **Validate output** — verify the YAML frontmatter parses correctly and all required fields are present before finalizing. Confirm `session_id`, `schema_version`, `project`, `cwd`, and `source_path` are populated; check that `session_type` contains at least one valid vocabulary term.

## Handling Missing Metadata

When a metadata field cannot be determined, apply the following fallbacks rather than omitting the field:

| Field | Fallback value |
|---|---|
| `session_id` | `"unknown"` |
| `branch` | `"unknown"` |
| `source_path` | `"unknown"` |
| `cost_usd` | `0` |
| `input_tokens` / `output_tokens` / `cache_read_tokens` | `0` |
| `duration_min` | `0` |
| `error_count` | `0` |
| `tools_used` | `[]` |
| `files_touched` | *(omit field)* |

If `start_time` is unavailable, use the current timestamp and note it is approximate.

## Output Format

Write a single markdown file to stdout with this exact structure:

```markdown
---
tags:
  - claude-session
  - claude-session/{type}    # nested tag for each session_type
session_id: "{session_id}"
schema_version: 1

project: "{project_name}"
cwd: "{working_directory}"
branch: "{git_branch}"
model: "{model_name}"

start_time: {ISO8601_timestamp}
duration_min: {minutes}

cost_usd: {cost}
input_tokens: {input}
output_tokens: {output}
cache_read_tokens: {cache_read}

user_turns: {count}
assistant_turns: {count}
tools_used: [{tool1}, {tool2}, ...]
files_touched:
  - "[[relative/path/to/file.ts]]"

error_count: {number}

session_type:
  - {type1}
  - {type2}

source_path: "{absolute_path_to_jsonl}"
---

## Summary

2-3 sentences describing what was accomplished in this session.

## Decisions

- **Decision 1**: Why this choice was made
- **Decision 2**: Why this choice was made

## Learnings

- Non-obvious discovery or gotcha worth remembering
- Pattern that worked well or should be avoided

## Key Exchanges

> User: The important question or request...
> Assistant: The key insight or solution...
```

## Session Type Vocabulary

Use one or more of these values for `session_type`:

`bug-fix` | `feature` | `refactor` | `exploration` | `discussion` | `config` | `docs` | `test` | `review` | `deploy`

## Note Naming Convention

`{project}--{YYYY-MM-DD}--{short-id}.md`

- `project`: sanitized project name (non-alphanumeric → hyphens, lowercase)
- `YYYY-MM-DD`: from start_time
- `short-id`: first 8 characters of session_id

Example: `claude-sessions--2026-04-08--a1b2c3d4.md`

## Frontmatter Field Rules

1. **Exact values required** for: `session_id`, `schema_version`, `project`, `cwd`, `source_path`
2. **Approximate OK** for: `duration_min`, `cost_usd`, token counts (Layer 0 will correct)
3. **LLM-only fields**: `session_type` (you classify), Summary/Decisions/Learnings/Key Exchanges sections
4. **Wikilinks**: `files_touched` uses `[[path]]` syntax for Obsidian linking
