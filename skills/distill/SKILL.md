# /distill — Live Session Distillation

Distill the current Claude Code session into a structured Obsidian note with queryable frontmatter.

## When to Use

Run `/distill` at the end of a session to capture:
- What you accomplished (summary)
- Key decisions and their reasoning
- Non-obvious learnings or gotchas
- Important exchanges that should be preserved

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

Use these values for `session_type` (multi-select):

| Type | Description |
|---|---|
| `bug-fix` | Diagnosing and fixing a defect |
| `feature` | Building new functionality |
| `refactor` | Restructuring without behavior change |
| `exploration` | Reading/understanding code, research |
| `discussion` | Brainstorming, design, planning |
| `config` | CI, deps, build, tooling, settings |
| `docs` | Documentation, comments, READMEs |
| `test` | Writing or fixing tests |
| `review` | Code review, audit, PR review |
| `deploy` | Release, publish, deploy operations |

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

## Workflow

Since `/distill` runs in Claude Code (not Obsidian), it outputs to stdout with a placeholder `session_id`. To get accurate metadata merged with your narrative:

1. Run `/distill` at the end of your session
2. **Copy the output** to clipboard
3. Open the same session in the Obsidian plugin timeline view
4. Run command: **"Merge /distill output from clipboard"**

The plugin will:
- Use the real `session_id` from the active session
- Replace approximate token/cost values with exact parsed values
- Preserve your Summary, Decisions, Learnings, Key Exchanges sections
- Merge `files_touched` and `tags` arrays from both sources

## Installation

To install this skill globally for all projects:

```bash
cp -r .claude/skills/distill ~/.claude/skills/
```

Then run `/distill` at the end of any Claude Code session.
