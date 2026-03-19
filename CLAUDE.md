# Agent Sessions — Obsidian Plugin

## Origin

Inspired by [claude-replay](https://github.com/es617/claude-replay), this plugin brings AI coding agent session replay natively into Obsidian. Rather than a standalone web app, sessions live alongside your notes — importable, replayable, and exportable as markdown or self-contained HTML.

## Status

**v0.1.0 — MVP complete.**

Working features:
- Claude Code JSONL parser with deduplication, streaming support, and metadata extraction
- Codex CLI parser (event-based format)
- Cursor parser (stub — detection only)
- Auto-format detection from first lines of file
- Replay view (ItemView) with turn-by-turn navigation, auto-play, speed controls (0.5x–5x)
- Keyboard shortcuts: Arrow keys (nav), Space (play/pause), `[`/`]` (speed)
- Session browser (FuzzySuggestModal) scanning configured directories recursively
- File picker modal for arbitrary .jsonl import
- Markdown export with frontmatter and Obsidian callouts
- HTML export as self-contained replay file with embedded player
- Settings tab: session directories, export preferences, display toggles, playback speed
- Collapsible thinking blocks and tool call/result blocks
- Code blocks rendered with syntax highlighting via MarkdownRenderer
- Accessible: ARIA labels, focus-visible indicators, 44px touch targets

## Architecture

```
src/
  main.ts                          # Plugin entry, commands, view registration
  settings.ts                      # Settings tab
  types.ts                         # Shared interfaces (Session, Turn, ContentBlock, etc.)
  parsers/
    base-parser.ts                 # Abstract base with shared utilities
    claude-parser.ts               # Claude Code JSONL parser
    codex-parser.ts                # Codex CLI parser
    cursor-parser.ts               # Cursor transcript parser (stub)
    detect.ts                      # Format auto-detection
  views/
    replay-view.ts                 # ItemView — replay pane
    replay-renderer.ts             # DOM rendering (turns, blocks, controls)
    session-browser-modal.ts       # FuzzySuggestModal for browsing sessions
    file-picker-modal.ts           # Import from arbitrary path
  exporters/
    markdown-exporter.ts           # Markdown with frontmatter & callouts
    html-exporter.ts               # Self-contained HTML replay
  utils/
    path-utils.ts                  # Home dir expansion, path helpers
    streaming-reader.ts            # File reading (Node.js streams on desktop)
styles.css                         # Scoped styles using Obsidian CSS variables
```

## Commands

| ID | Name |
|---|---|
| `browse-sessions` | Browse agent sessions |
| `import-file` | Import session file |
| `export-markdown` | Export session to markdown |
| `export-html` | Export session to HTML |
| `toggle-playback` | Toggle session playback |
| `next-turn` | Go to next turn |
| `prev-turn` | Go to previous turn |

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # production build (typecheck + bundle)
```

Copy `main.js`, `styles.css`, and `manifest.json` to your vault's `.obsidian/plugins/agent-sessions/` directory.

## Roadmap

### Near-term
- [ ] Cursor parser — full implementation once transcript format is documented
- [ ] Progress bar/notice for large file imports (10MB+)
- [ ] Vault-based session browsing for mobile support
- [ ] Search/filter sessions by project, date range, or model
- [ ] Persist last-viewed turn per session across restarts (setState/getState)

### Medium-term
- [ ] Diff view for tool results (show file changes inline)
- [ ] Session statistics panel (token counts, tool usage breakdown, duration)
- [ ] Multi-turn view — render all turns scrollably instead of one-at-a-time
- [ ] Linked mentions — link tool_use file paths to vault files when they exist
- [ ] Tag/bookmark individual turns for later reference

### Long-term
- [ ] Session comparison — side-by-side diff of two sessions
- [ ] Cost estimation from token usage metadata
- [ ] Timeline visualization of session flow
- [ ] Plugin API for custom parsers (third-party agent formats)
- [ ] Obsidian Publish-compatible export theme
