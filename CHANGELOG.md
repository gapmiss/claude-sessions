# Changelog

All notable changes to Claude Sessions are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/).

For Claude Code version compatibility, see [COMPATIBILITY.md](COMPATIBILITY.md).

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
