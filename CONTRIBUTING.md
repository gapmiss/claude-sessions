# Contributing

Thanks for helping out.

## Bug reports

Open an issue with the steps to reproduce, what you expected, and what happened instead. Include your Claude Code version (`claude --version`) and the plugin version.

If a session shows a parse warning, [COMPATIBILITY.md](COMPATIBILITY.md#reporting-a-format-change) explains what to include.

## Pull requests

1. Fork the repository and create a branch
2. Make your change
3. Run `npm test`, `npm run build`, and `npx eslint .`. All three should pass cleanly
4. Try it in Obsidian
5. Open a PR that explains what changed and why

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the code fits together, and [GOTCHAS.md](GOTCHAS.md) lists the traps we already know about.

## Development

```bash
npm install
npm run dev          # watch mode
npm run build        # production build
npm test             # run tests
```

`npm run build` doesn't install the plugin anywhere. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/claude-sessions/` and reload the plugin.
