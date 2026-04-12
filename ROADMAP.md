# Roadmap — Claude Sessions Plugin

## Near-term

- [ ] Incremental parsing — track byte/line offset, only parse new lines on reload
- [x] Incremental DOM rendering — append new turns instead of full re-render
- [ ] Progress bar/notice for large file imports (10MB+)
- [x] ~~Search/filter sessions by project, date range, or model~~ — cross-session keyword search with BM25 relevance ranking
- [ ] Semantic search — embeddings-based search for concept-level queries
- [ ] Skip filtered blocks during segment-level navigation (arrow keys currently land on hidden blocks)
- [ ] Full-resolution tool result images — Read tool image results are downscaled by Claude Code (~25x) before JSONL embedding; try loading from original `file_path` on disk with base64 fallback
- [ ] Batch distill — distill multiple/all sessions at once from browser modal

## Medium-term

- [ ] Linked mentions — link tool_use file paths to vault files when they exist
- [ ] Tag/bookmark individual turns for later reference
- [x] ~~Cost estimation from token usage metadata~~ — displayed in summary dashboard hero card and header inline stats
- [ ] Session comparison — side-by-side diff of two sessions
- [x] ~~Session distillation~~ — Layer 0 extraction to structured notes with Obsidian Bases dashboards
- [x] ~~Public API~~ — inter-plugin communication (`getActiveSession`, `parseSessionFile`, `onSessionParsed`, `getSessionIndex`)

## Long-term

- [ ] Timeline visualization of session flow
- [x] ~~Plugin API for custom parsers~~ — replaced by public API for inter-plugin communication
- [ ] Obsidian Publish-compatible export theme
- [ ] Mobile support (vault-based session browsing)
- [ ] Layer 1+ distillation — LLM-powered summarization and classification via Claude API

## Completed (0.2.13+)

- [x] System events panel — hooks, skills, task reminders in collapsible panel
- [x] Inline hook indicators — PreToolUse (zap), PermissionRequest (shield) icons on tool calls
- [x] Custom session titles — `/rename` command support with search integration
- [x] Expand/collapse all blocks — commands for bulk toggle of tools, thinking, summary
- [x] AskUserQuestion renderer — dedicated Q&A display
- [x] ToolSearch renderer — tool_reference parsing with match display
- [x] Sub-agent JSONL resolution — reads from `subagents/*.jsonl` files
