# Changelog

All notable changes to Claude Sessions are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/).

For Claude Code version compatibility, see [COMPATIBILITY.md](COMPATIBILITY.md).

---

## [0.3.1] - 2026-04-18

### Fixed
- **Rate limits** - return null on error instead of stale cached data
- **Timeline thinking blocks** - preserve thinking block state across UI refreshes

## [0.3.0] - 2026-04-18

### Added
- **Compaction tracking** — stats now include compaction event count and peak context window size
- **mjs/cjs syntax highlighting** — JavaScript module extensions recognized in code blocks

### Fixed
- **Search highlight precision** — clicking search results now highlights the exact match text within INPUT blocks (Bash, Edit, Write, generic), not just scrolling to the turn
- **Edit/Write search noise** — filtered out "The file has been updated successfully" boilerplate from search index (these messages aren't rendered)
- **Closed session detection** — search panel detects when tracked session is closed and clears stale state
- **Search keyboard navigation** — options menu positioning fixed, proper focus management
- **Search view styles** — consistent styling across light/dark themes

### Changed
- **Turn-based in-session search** — refactored to use precise content-block coordinates with `data-content-block-idx` stamps for DOM highlighting
- Rate limit cache TTL reduced to 1 minute (was 5 minutes) to reduce 429 errors

---

## [0.2.15]

### Added
- `context_tokens` field in distill frontmatter (context window size from session stats)
- `title` field in distill frontmatter (custom session name from `/rename` command)
- Logger-based debugging for rate limits module

### Fixed
- Duration calculation now uses active time instead of wall-clock time — resumed sessions no longer show inflated durations (e.g., 17,000+ minutes for sessions spanning multiple days)
- Tab title updates correctly when session is renamed during live watch
- Line number indentation preserved when stripping from Read tool output
- System-reminder tags stripped from Read tool results
- Expand/collapse all now includes text blocks
- Relative time formatting no longer shows "3h 60m"
- Distill merge serialization preserves field ordering for new fields

### Changed
- Updated `/distill` skill template with new frontmatter fields
- Updated GOTCHAS.md with frontmatter serialization touchpoints
- Added warning about Claude Code's 30-day session cleanup to docs

---

## [0.2.14] - 2026-04-12

### Fixed
- Obsidian reviewbot scan issues
- Rate limit TTL changed from 5 mins to 1 min
- All AUDIT-2026-04-12 priority items addressed

### Changed
- README.md refactored
- Distill SKILL.md optimized

---

## [0.2.13] - 2026-04-12

### Added
- Session distillation to structured notes with YAML frontmatter (Layer 0, zero LLM cost)
- Clipboard merge workflow for combining `/distill` LLM output with exact session stats
- Obsidian Bases dashboard templates (Session Dashboard, Cost Tracker, Recent Sessions, Error Patterns)
- System events panel showing hooks, skills, and task reminders
- Inline hook indicators on tool calls (zap icon for PreToolUse, shield icon for PermissionRequest)
- Custom session title support from `/rename` command
- Public API for inter-plugin communication (`getActiveSession`, `parseSessionFile`, `onSessionParsed`, `getSessionIndex`)
- Expand/collapse all blocks commands
- Search panel refresh button

### Changed
- Updated documentation (ARCHITECTURE.md, GOTCHAS.md, ROADMAP.md, CLAUDE.md, README.md)

---

## [0.2.12] - 2026-04-10

### Added
- ToolSearch tool renderer with `tool_reference` block parsing
- AskUserQuestion tool renderer with Q&A display
- Show more/less toggles working in HTML exports

### Fixed
- Sub-agent session resolution from separate JSONL files (`subagents/agent-<id>.jsonl`)

---

## [0.2.11] - 2026-04-08

### Fixed
- ANSI escape codes using `String.fromCharCode(0x1b)` instead of literal `\x1b` (community plugin scan compliance)

---

## [0.2.10] - 2026-04-07

### Fixed
- Resolved all Obsidian community plugin scan lint violations

---

## [0.2.9] - 2026-04-06

### Fixed
- Minor manifest updates

---

## [0.2.8] - 2026-04-05

### Fixed
- Manifest description update

---

## [0.2.7] - 2026-04-04

### Fixed
- ESLint configuration cleanup

---

## [0.2.6] - 2026-04-03

### Added
- BM25 relevance-ranked search
- Per-session pin state for summary dashboard
- Expand-to-highlight in search navigation

### Fixed
- Search accuracy and navigation reliability
- Interactive element accessibility (makeClickable)
- HTML export CSS snippet theme overrides

---

## [0.2.5] - 2026-04-01

### Added
- Rate limit utilization display in summary hero cards (beta, opt-in)
- Reset time display below rate limit progress bars

### Fixed
- Pinned hero scrollbar behavior
- Progress tooltip clipping
- Export markdown title handling

### Removed
- Hook icons feature (dead JSONL format from older Claude Code versions)

---

## [0.2.0] - 2026-03-15

### Added
- Initial public release
- Session timeline view with turn rendering
- Tool-specific renderers (Bash, Edit, Write, Read)
- Summary dashboard with hero cards and charts
- Live watch with UI state preservation
- Cross-session and in-session search
- HTML and Markdown export
- Deep linking via protocol handler

---

[0.3.1]: https://github.com/gapmiss/claude-sessions/compare/0.3.0...HEAD
[0.3.0]: https://github.com/gapmiss/claude-sessions/compare/0.2.15...0.3.0
[0.2.15]: https://github.com/gapmiss/claude-sessions/compare/0.2.14...0.2.15
[0.2.14]: https://github.com/gapmiss/claude-sessions/compare/0.2.13...0.2.14
[0.2.13]: https://github.com/gapmiss/claude-sessions/compare/0.2.12...0.2.13
[0.2.12]: https://github.com/gapmiss/claude-sessions/compare/0.2.11...0.2.12
[0.2.11]: https://github.com/gapmiss/claude-sessions/compare/0.2.10...0.2.11
[0.2.10]: https://github.com/gapmiss/claude-sessions/compare/0.2.9...0.2.10
[0.2.9]: https://github.com/gapmiss/claude-sessions/compare/0.2.8...0.2.9
[0.2.8]: https://github.com/gapmiss/claude-sessions/compare/0.2.7...0.2.8
[0.2.7]: https://github.com/gapmiss/claude-sessions/compare/0.2.6...0.2.7
[0.2.6]: https://github.com/gapmiss/claude-sessions/compare/0.2.5...0.2.6
[0.2.5]: https://github.com/gapmiss/claude-sessions/compare/0.2.0...0.2.5
[0.2.0]: https://github.com/gapmiss/claude-sessions/releases/tag/0.2.0
