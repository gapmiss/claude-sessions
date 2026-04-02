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
- **Last session**: 2026-04-01 20:30
- **Goal**: Fix audit items — slash command stdout display, dead code removal, doc restructuring
- **Summary**: Implemented slash command stdout capture for system-type local commands (`/status`, `/rename`, `/doctor`, etc.) so their output displays inline. Fixed bogus "Slash output" blocks caused by `<local-command-caveat>` records being misidentified as skill expansions. Committed all audit fixes: dead code removal (duplicate `basename()`, unused constants, dead `guessFormat()`), greedy regex fix, sub-agent state save/restore, code quality improvements, and CLAUDE.md restructuring into slim version + reference docs.
- **Decisions**:
  - System record stdout captured via same `pendingCommand` mechanism as user records — avoids duplicating logic
  - Caveat filtering added to `extractSkillExpansionText` rather than the isMeta check — more precise, doesn't affect other isMeta handling
  - All audit fixes committed together as one cohesive commit rather than split
- **Next steps**:
  - Verify ESLint works with new `@eslint/json` dependency
  - Address remaining audit items (incremental parsing for large sessions)
  - Test slash command stdout display with more command types
- **Blockers**: None
- **Branch**: main
- **Uncommitted**: Clean
