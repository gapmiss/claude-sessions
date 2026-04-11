# Claude Sessions — Obsidian Plugin

Desktop-only Claude Code JSONL session viewer for Obsidian. Browse, search, and export sessions with rich tool rendering, live watch, and summary dashboards.

**Version**: 0.2.12 | **Branch**: main

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
    tool-renderer.ts         # Tool-specific rendering (Bash, Edit, Write, Read, Agent, AskUserQuestion, ToolSearch)
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
    rate-limits.ts           # OAuth credential reading + Anthropic usage API (beta)
    session-index.ts         # Persistent metadata cache (JSON on disk)
    session-search.ts        # Line-by-line JSONL grep + BM25-ranked search
    bm25.ts                  # BM25 relevance scoring engine (tokenizer, stemmer, index)
    streaming-reader.ts      # File I/O (Node.js streams, metadata extraction)
    logger.ts                # Configurable log levels
```

## Code Exploration Policy (Mandatory)

Use `cymbal` CLI for code navigation — prefer it over Read, Grep, Glob, or Bash for code exploration.
- **New to a repo?**: `cymbal structure` — entry points, hotspots, central packages. Start here.
- **To understand a symbol**: `cymbal investigate <symbol>` — returns source, callers, impact, or members based on what the symbol is.
- **To understand multiple symbols**: `cymbal investigate Foo Bar Baz` — batch mode, one invocation.
- **To trace an execution path**: `cymbal trace <symbol>` — follows the call graph downward (what does X call, what do those call).
- **To assess change risk**: `cymbal impact <symbol>` — follows the call graph upward (what breaks if X changes).
- Before reading a file: `cymbal outline <file>` or `cymbal show <file:L1-L2>`
- Before searching: `cymbal search <query>` (symbols) or `cymbal search <query> --text` (grep)
- Before exploring structure: `cymbal ls` (tree) or `cymbal ls --stats` (overview)
- To disambiguate: `cymbal show path/to/file.go:SymbolName` or `cymbal investigate file.go:Symbol`
- First run: `cymbal index .` to build the initial index (<1s). After that, queries auto-refresh — no manual reindexing needed.
- All commands support `--json` for structured output.

## Conventions

- **Constants**: All JSONL magic strings (record types, XML tags, regexes) live in `constants.ts`
- **DOM**: Programmatic construction only — no `innerHTML` in renderer pipeline. Use Obsidian's `createEl`/`createDiv`/`createSpan`
- **Accessibility**: All interactive elements get `makeClickable()` (tabindex, role, aria-expanded, Enter/Space)
- **CSS**: Scoped under `claude-sessions-*`, Obsidian CSS variables only, no inline styles (exception: ANSI color rendering)
- **Parsing**: Consecutive assistant records merge into one Turn. Tool results attach to preceding assistant turn. Dedup by uuid
- **HTML export**: CSS class toggling (`open`/`collapsed`) drives visibility — not display style manipulation. Copy buttons need `data-copy-text` attributes since closures don't survive DOM cloning
- **Platform**: Use `Platform.isDesktop`/`Platform.isMobile`, never `navigator.platform`. Use `requestUrl()` not `fetch()`
- **Network**: Rate limit feature (beta, opt-in) uses `requestUrl()` to call `api.anthropic.com/api/oauth/usage`. OAuth token read from macOS Keychain or `~/.claude/.credentials.json`. 5-minute in-memory cache

## Key References

For detailed architecture, parser logic, and rendering pipeline: `@ARCHITECTURE.md`
For known pitfalls and platform-specific behaviors: `@GOTCHAS.md`
For planned features: `@ROADMAP.md`
Audit results: `@AUDIT-2026-04-01.md`