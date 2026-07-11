# Claude Sessions — Obsidian Plugin

Desktop-only Claude Code JSONL session viewer for Obsidian. Browse, search, and export sessions with rich tool rendering, live watch, and summary dashboards.

**Version**: 0.3.2 | **Branch**: main

## Development

```bash
npm run dev          # watch mode
npm run build        # production (typecheck + bundle + copy to vault)
npm test             # vitest
npm run test:watch   # watch mode tests
npx eslint .         # lint
```

## File Structure

```
src/
  main.ts                    # Plugin entry, commands, protocol handler
  settings.ts                # Settings tab
  types.ts                   # All shared interfaces and types
  constants.ts               # JSONL protocol strings, regexes, display strings
  api.ts                     # Public API for inter-plugin communication
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
    system-events-renderer.ts # System events panel (hooks, skills, task reminders)
    tool-renderer.ts         # Tool-specific rendering (Bash, Edit, Write, Read, Agent, AskUserQuestion, ToolSearch)
    search-view.ts           # Dual-mode search panel (cross-session / in-session)
    session-browser-modal.ts # SuggestModal with cached session index
    file-picker-modal.ts     # Import via drag-drop or path
    export-modal.ts          # Export options modal (summary/events toggles, persistent)
  exporters/
    html-exporter.ts         # DOM snapshot → standalone HTML, conditional summary/events
    css-capture.ts           # Theme/app/plugin CSS extraction
    standalone-player.ts     # Embedded JS for exported HTML interactivity
    markdown-exporter.ts     # Markdown with rich frontmatter, summary, system events, tool rendering
  distill/
    distill-session.ts       # Distill orchestrator (extract → find → merge → write)
    extract-frontmatter.ts   # Session stats → YAML frontmatter
    serialize-frontmatter.ts # Frontmatter serialization/parsing
    build-note.ts            # Note content generation + merge logic
    find-existing.ts         # Existing note lookup by session_id
    bases-templates.ts       # Obsidian Bases dashboard templates
    types.ts                 # DistilledFrontmatter, SessionType, DistillOptions
  utils/
    path-utils.ts            # expandHome, basename, dirname, shortenPath
    rate-limits.ts           # OAuth credential reading + Anthropic usage API (beta)
    session-index.ts         # Persistent metadata cache (JSON on disk)
    session-search.ts        # Line-by-line JSONL grep + BM25-ranked search
    bm25.ts                  # BM25 relevance scoring engine (tokenizer, stemmer, index)
    streaming-reader.ts      # File I/O (Node.js streams, metadata extraction)
    logger.ts                # Configurable log levels
    folder-suggest.ts        # Vault folder autocomplete for settings
```

## Code exploration (cymbal)

Prefer `cymbal` over Read/Grep/Glob for code questions — its scoped output
keeps whole files and broad greps out of context (the real token lever).
If `cymbal` isn't on PATH, fall back to Read/Grep.

Trigger → command:
- Unfamiliar repo → `cymbal structure` (entry points, hotspots). Start here.
- A symbol → `cymbal investigate <sym>` (source, callers, impact, members).
  Several → `cymbal investigate A B C` — one call, batch.
- Call graph → `cymbal trace <sym>` (downward) / `cymbal impact <sym>` (upward).
- Before a Read → `cymbal outline <file>`, then `cymbal show <file:L1-L2>` for the hit only.
- Before a grep → `cymbal search <query>` (symbols) / `--text` (content).
- Ambiguous name → `cymbal show <file:Symbol>`.

Setup: first use per repo, `cymbal index .` (<1s); auto-refreshes — never reindex manually.
Don't fall back to a full Read or recursive grep when cymbal can scope the answer.

## Conventions

- **Constants**: All JSONL magic strings (record types, XML tags, regexes) live in `constants.ts`
- **DOM**: Programmatic construction only — no `innerHTML` in renderer pipeline. Use Obsidian's `createEl`/`createDiv`/`createSpan`
- **Accessibility**: All interactive elements get `makeClickable()` (tabindex, role, aria-expanded, Enter/Space)
- **CSS**: Scoped under `claude-sessions-*`, Obsidian CSS variables only, no inline styles (exception: ANSI color rendering)
- **Parsing**: Consecutive assistant records merge into one Turn. Tool results attach to preceding assistant turn. Dedup by uuid
- **Export**: Both exporters accept `ExportOptions` (from modal). Summary and system events are opt-in via persistent toggles. HTML strips DOM panels; Markdown skips sections
- **HTML export**: CSS class toggling (`open`/`collapsed`) drives visibility — not display style manipulation. Copy buttons need `data-copy-text` attributes since closures don't survive DOM cloning
- **Platform**: Use `Platform.isDesktop`/`Platform.isMobile`, never `navigator.platform`. Use `requestUrl()` not `fetch()`
- **Network**: Rate limit feature (beta, opt-in) uses `requestUrl()` to call `api.anthropic.com/api/oauth/usage`. OAuth token read from macOS Keychain or `~/.claude/.credentials.json`. 1-minute in-memory cache
- **Distill**: Layer 0 extraction only (no LLM cost). Frontmatter values from session stats. LLM summaries via clipboard merge workflow
- **Public API**: Stable surface — additions fine, removals breaking. Access via `app.plugins.plugins['claude-sessions']?.api`

## Key References

For detailed architecture, parser logic, and rendering pipeline: `@ARCHITECTURE.md`
For known pitfalls and platform-specific behaviors: `@GOTCHAS.md`
For planned features: `@ROADMAP.md`
For version history: `@CHANGELOG.md`
For Claude Code version compatibility: `@COMPATIBILITY.md`
Audit results: `@AUDIT-2026-04-01.md`