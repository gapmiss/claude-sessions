# Claude Sessions — Obsidian Plugin

Desktop-only Claude Code JSONL session viewer for Obsidian. Browse, search, and export sessions with rich tool rendering, live watch, and summary dashboards.

**Version**: 0.1.1 | **Branch**: main

## Development

```bash
npm run dev          # watch mode
npm run build        # production (typecheck + bundle + copy to vault)
npm test             # vitest
npm run test:watch   # watch mode tests
npx eslint .         # lint (requires `npm i -D @eslint/json` — currently broken)
```

## File Structure

```
src/
  main.ts                    # Plugin entry, commands, protocol handler
  settings.ts                # Settings tab
  types.ts                   # All shared interfaces and types
  constants.ts               # JSONL protocol strings, regexes, display strings
  parsers/
    claude-parser.ts         # Core JSONL parser (record merging, dedup, stats)
    claude-content.ts        # Content block parsing, tool result extraction
    claude-subagent.ts       # Sub-agent JSONL resolution
    base-parser.ts           # Abstract base (splitLines, tryParseJson)
    detect.ts                # Format detection
  views/
    timeline-view.ts         # ItemView — timeline, controls, filters, live watch
    timeline-renderer.ts     # Turn/block rendering, ANSI, mermaid, image modals
    render-helpers.ts        # Shared: makeClickable, fence, langFromPath, etc.
    summary-renderer.ts      # Dashboard panel (hero cards, charts, metadata)
    tool-renderer.ts         # Tool-specific rendering (Bash, Edit, Write, Read, Agent)
    search-view.ts           # Dual-mode search panel (cross-session / in-session)
    session-browser-modal.ts # SuggestModal with cached session index
    file-picker-modal.ts     # Import via drag-drop or path
  exporters/
    html-exporter.ts         # DOM snapshot → standalone HTML
    css-capture.ts           # Theme/app/plugin CSS extraction
    standalone-player.ts     # Embedded JS for exported HTML interactivity
    markdown-exporter.ts     # Markdown with frontmatter
  utils/
    path-utils.ts            # expandHome, basename, dirname, shortenPath
    session-index.ts         # Persistent metadata cache (JSON on disk)
    session-search.ts        # Line-by-line JSONL grep engine
    streaming-reader.ts      # File I/O (Node.js streams, metadata extraction)
    logger.ts                # Configurable log levels
```

## Conventions

- **Constants**: All JSONL magic strings (record types, XML tags, regexes) live in `constants.ts`
- **DOM**: Programmatic construction only — no `innerHTML` in renderer pipeline. Use Obsidian's `createEl`/`createDiv`/`createSpan`
- **Accessibility**: All interactive elements get `makeClickable()` (tabindex, role, aria-expanded, Enter/Space)
- **CSS**: Scoped under `claude-sessions-*`, Obsidian CSS variables only, no inline styles (exception: ANSI color rendering)
- **Parsing**: Consecutive assistant records merge into one Turn. Tool results attach to preceding assistant turn. Dedup by uuid
- **HTML export**: CSS class toggling (`open`/`collapsed`) drives visibility — not display style manipulation. Copy buttons need `data-copy-text` attributes since closures don't survive DOM cloning
- **Platform**: Use `Platform.isDesktop`/`Platform.isMobile`, never `navigator.platform`. Use `requestUrl()` not `fetch()` (though no network requests currently)

## Key References

For detailed architecture, parser logic, and rendering pipeline: `@ARCHITECTURE.md`
For known pitfalls and platform-specific behaviors: `@GOTCHAS.md`
For planned features: `@ROADMAP.md`
Audit results: `@AUDIT-2026-04-01.md`

## Session State
<!-- DO NOT edit this section manually. It is managed exclusively by /wrap SKILL. -->
<!-- auto-updated by /wrap -->
- **Last session**: 2026-04-01
- **Goal**: Comprehensive audit + CLAUDE.md restructuring
- **Summary**: Completed full audit (dead code, security, JSONL resilience, Obsidian rules). Found 10 unused constants, duplicate basename(), broken ESLint dep, parser state save/restore gap. Split CLAUDE.md into slim version + ARCHITECTURE.md + GOTCHAS.md + ROADMAP.md to reduce per-turn token overhead.
- **Decisions**:
  - CLAUDE.md kept to ~60 lines — only conventions, commands, file tree
  - Detailed architecture/parser docs moved to ARCHITECTURE.md (@ referenced on demand)
  - Gotchas moved to GOTCHAS.md — not needed every turn
  - Roadmap moved to ROADMAP.md
- **Next steps**:
  - Fix ESLint dependency (`npm i -D @eslint/json`)
  - Address high/medium priority audit items
  - Incremental parsing/rendering for large sessions
- **Blockers**: None
- **Branch**: main
- **Uncommitted**: Clean
