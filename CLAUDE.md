# Claude Sessions (Obsidian plugin)

Desktop-only viewer for Claude Code JSONL sessions. Browse, search, and export sessions with rich tool rendering, live watch, and a summary dashboard.

**Version**: 0.3.26 | **Branch**: main

## Development

```bash
npm run dev          # watch mode
npm run build        # typecheck + production bundle (does not copy to a vault)
npm test             # vitest
npm run test:watch   # vitest in watch mode
npx eslint .         # lint
npm run release      # bump patch, build, commit, tag, push (release:minor, release:major)
```

`npm run release` pushes to GitHub, and the tag triggers the release workflow. Don't run it unless asked.

## File structure

```
src/
  main.ts                    # Plugin entry, commands, protocol handler
  settings.ts                # Declarative settings tab (getSettingDefinitions, 1.13.0+)
  types.ts                   # Shared interfaces, DEFAULT_SETTINGS
  constants.ts               # JSONL record types, XML tags, regexes, reviewed-and-skipped maps
  api.ts                     # Public API for other plugins
  electron.d.ts              # Minimal Electron types (save dialog)
  parsers/
    claude-parser.ts         # Core JSONL parser (record merging, dedup, stats, cost)
    claude-content.ts        # Content block parsing, tool result extraction
    claude-subagent.ts       # Sub-agent JSONL resolution
    base-parser.ts           # Abstract base (splitLines, tryParseJson)
    detect.ts                # Format detection
  views/
    timeline-view.ts         # ItemView: timeline, controls, filters, live watch
    timeline-renderer.ts     # Turn and block rendering, ANSI, mermaid, image modals
    render-helpers.ts        # Shared helpers: makeClickable, fence, stripFenceMarkers, normalizeMarkdown
    summary-renderer.ts      # Dashboard panel (hero cards, charts, metadata)
    system-events-renderer.ts # System events panel (hooks, skills, output style, permissions)
    tool-renderer.ts         # Per-tool rendering (Bash, Edit, Write, Read, WebFetch, Agent, Task*, AskUserQuestion, ToolSearch)
    search-view.ts           # Search panel (cross-session and in-session)
    session-browser-modal.ts # SuggestModal over the cached session index, with pinning
    file-picker-modal.ts     # Import by drag-and-drop or path
    export-modal.ts          # Export options (summary and system events toggles)
  exporters/
    html-exporter.ts         # DOM snapshot to standalone HTML
    css-capture.ts           # Theme, app, and plugin CSS extraction
    standalone-player.ts     # Embedded JS for exported HTML
    markdown-exporter.ts     # Markdown with frontmatter, summary, system events, tool rendering
  distill/
    distill-session.ts       # Orchestrator (extract, find, merge, write)
    extract-frontmatter.ts   # Session stats to YAML frontmatter
    serialize-frontmatter.ts # Frontmatter serialization and parsing
    build-note.ts            # Note generation and merge logic
    find-existing.ts         # Existing note lookup by session_id
    bases-templates.ts       # Obsidian Bases dashboard templates
    types.ts                 # DistilledFrontmatter, SessionType, DistillOptions
  utils/
    path-utils.ts            # expandHome, basename, dirname, shortenPath
    rate-limits.ts           # OAuth credential lookup and Anthropic usage API (beta)
    session-index.ts         # Persistent metadata cache (JSON on disk)
    session-search.ts        # Line-by-line JSONL search with BM25 ranking
    bm25.ts                  # BM25 scoring (tokenizer, stemmer, index)
    streaming-reader.ts      # File I/O (Node streams, metadata extraction)
    logger.ts                # Configurable log levels
tests/                       # Vitest suites and fixtures
skills/distill/SKILL.md      # The /distill skill for Claude Code
```

## Conventions

- **Constants**: every JSONL magic string (record types, XML tags, regexes) lives in `constants.ts`.
- **New record or attachment types**: when the parser warns about an unknown type, sample real records before deciding anything. If it's worth rendering, handle it. If not, add it to `REVIEWED_ATTACHMENT_TYPES` or `REVIEWED_RECORD_TYPES` with a reason saying what it holds and why the reader doesn't need it. Either way, add a row to `COMPATIBILITY.md`.
- **DOM**: build it with `createEl`, `createDiv`, and `createSpan`. No `innerHTML` in the renderer pipeline.
- **Accessibility**: every interactive element goes through `makeClickable()` (tabindex, role, aria-expanded, Enter and Space).
- **CSS**: classes are prefixed `claude-sessions-`. Use Obsidian CSS variables. No inline styles, except for ANSI colors.
- **Parsing**: consecutive assistant records merge into one turn. Tool results attach to the preceding assistant turn. Records are deduplicated by uuid.
- **Export**: both exporters take `ExportOptions` from the modal. The summary and system events are opt-in toggles that persist. HTML export strips those DOM panels; Markdown export skips the sections.
- **HTML export**: visibility is driven by toggling the `open` and `collapsed` classes, never by setting `display`. Copy buttons need a `data-copy-text` attribute, because closures don't survive DOM cloning.
- **Platform**: use `Platform.isDesktop` and `Platform.isMobile`, never `navigator.platform`. Use `requestUrl()`, not `fetch()`.
- **Network**: the only network call is the opt-in rate limit feature (beta). It calls `api.anthropic.com/api/oauth/usage` with `requestUrl()`, reads the OAuth token from the macOS Keychain or `~/.claude/.credentials.json`, and caches the result in memory for one minute.
- **Distill**: frontmatter comes straight from session stats, with no LLM cost. LLM summaries arrive through the clipboard merge workflow.
- **Public API**: treat it as stable. Adding things is fine; removing things is a breaking change. Other plugins reach it at `app.plugins.plugins['claude-sessions']?.api`.
- **Writing**: docs and anything a user sees (UI text, notices, parse warnings, exported Markdown) are written plainly, with no em-dashes. Code comments are exempt.

## Key references

- Architecture, parser pipeline, and rendering: `@ARCHITECTURE.md`
- Known pitfalls and platform quirks: `@GOTCHAS.md`
- Version history: `@CHANGELOG.md`
- Claude Code format changes by version: `@COMPATIBILITY.md`
- Theme variables: `@THEMING.md`
