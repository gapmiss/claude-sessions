# Roadmap — Claude Sessions Plugin

## Near-term

- [ ] Incremental parsing — track byte/line offset, only parse new lines on reload
- [x] Incremental DOM rendering — append new turns instead of full re-render
- [ ] Progress bar/notice for large file imports (10MB+)
- [x] ~~Search/filter sessions by project, date range, or model~~ — cross-session keyword search implemented
- [ ] Semantic search — embeddings-based search for concept-level queries
- [ ] Skip filtered blocks during segment-level navigation (arrow keys currently land on hidden blocks)
- [ ] Full-resolution tool result images — Read tool image results are downscaled by Claude Code (~25x) before JSONL embedding; try loading from original `file_path` on disk with base64 fallback

## Medium-term

- [ ] Linked mentions — link tool_use file paths to vault files when they exist
- [ ] Tag/bookmark individual turns for later reference
- [x] ~~Cost estimation from token usage metadata~~ — displayed in summary dashboard hero card and header inline stats
- [ ] Session comparison — side-by-side diff of two sessions

## Long-term

- [ ] Timeline visualization of session flow
- [ ] Plugin API for custom parsers (third-party agent formats)
- [ ] Obsidian Publish-compatible export theme
- [ ] Mobile support (vault-based session browsing)
