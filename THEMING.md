# Theming

Claude Sessions exposes CSS custom properties (`--cs-*`) that you can override via [Obsidian CSS snippets](https://help.obsidian.md/Extending+Obsidian/CSS+snippets) to create your own visual theme. By default, all values resolve to Obsidian's built-in CSS variables, so the plugin looks native in any Obsidian theme.

## Quick start

1. Create a `.css` file in your vault's `.obsidian/snippets/` folder
2. Override any `--cs-*` variable on `.claude-sessions-timeline-container`
3. Enable the snippet in **Settings > Appearance > CSS Snippets**

```css
/* .obsidian/snippets/my-claude-theme.css */
.claude-sessions-timeline-container {
  --cs-accent: #7c3aed;
  --cs-role-user: #7c3aed;
  --cs-role-assistant: #06b6d4;
  --cs-tool-name: #06b6d4;
  --cs-thinking-opacity: 0.3;
}
```

For light/dark variants, scope with the body class:

```css
.theme-light .claude-sessions-timeline-container {
  --cs-accent: #7c3aed;
}
.theme-dark .claude-sessions-timeline-container {
  --cs-accent: #a78bfa;
}
```

## Example theme

A complete Claude brand theme is included at [`examples/claude-sessions-theme-claude.css`](examples/claude-sessions-theme-claude.css). Copy it to `.obsidian/snippets/` and enable it to try it out.

## Available variables

### Accent & brand

| Variable | Default | Description |
|---|---|---|
| `--cs-accent` | `var(--interactive-accent)` | Primary interactive/accent color |
| `--cs-accent-hover` | `var(--interactive-accent-hover)` | Accent hover state |
| `--cs-accent-rgb` | `var(--interactive-accent-rgb)` | RGB triplet for `rgba()` usage |
| `--cs-accent-subtle` | `rgba(--cs-accent-rgb, 0.08)` | Low-opacity accent background |

### Role colors

| Variable | Default | Description |
|---|---|---|
| `--cs-role-user` | `var(--interactive-accent)` | User role badge and left border |
| `--cs-role-assistant` | `var(--color-cyan)` | Assistant role badge and left border |
| `--cs-role-border-width` | `3px` | Left border width on role sections |

### Tool & component colors

| Variable | Default | Description |
|---|---|---|
| `--cs-tool-indicator` | `var(--color-blue)` | Tool status dot |
| `--cs-tool-name` | `var(--color-cyan)` | Tool name text |
| `--cs-tool-group-header` | `var(--color-cyan)` | Tool group header text |
| `--cs-subagent-border` | `var(--color-orange)` | Sub-agent timeline left border |
| `--cs-progress-fill` | `var(--interactive-accent)` | Progress/scrub bar fill |

### Badge backgrounds

| Variable | Default | Description |
|---|---|---|
| `--cs-badge-error-bg` | `rgba(248, 81, 73, 0.15)` | Stop reason badge |
| `--cs-badge-warning-bg` | `rgba(210, 153, 34, 0.15)` | API error badge |
| `--cs-diff-del-bg` | `rgba(248, 81, 73, 0.1)` | Diff deletion highlight |
| `--cs-diff-add-bg` | `rgba(63, 185, 80, 0.1)` | Diff addition highlight |
| `--cs-ansi-bg-text` | `#1a1a1a` | ANSI background text color |

### Spacing

| Variable | Default | Description |
|---|---|---|
| `--cs-turn-gap` | `var(--size-4-6)` (24px) | Space between turns |
| `--cs-block-gap` | `var(--size-2-3)` (6px) | Space between tool/thinking/slash blocks |
| `--cs-padding-header` | `var(--size-2-3) 10px` | Padding inside collapsible headers |
| `--cs-padding-tool-body` | `var(--size-4-2) 10px` | Padding inside tool body panels |
| `--cs-padding-badge` | `1px 6px` | Padding inside small badges/pills |
| `--cs-padding-card` | `10px 6px 8px` | Dashboard hero card padding |
| `--cs-collapse-height` | `13em` | Max height before "Show more" |
| `--cs-max-scroll-height` | `400px` | Max scroll height for body panels |
| `--cs-max-scroll-height-sm` | `300px` | Max scroll height for tool input/result |

### Typography

| Variable | Default | Description |
|---|---|---|
| `--cs-font-family` | `var(--font-monospace)` | Main container and code blocks |
| `--cs-font-family-ui` | `var(--font-ui)` | Buttons, toggles, labels |
| `--cs-font-family-text` | `var(--font-text)` | Sub-agent output, markdown content |
| `--cs-font-size-base` | `var(--font-ui-small)` (13px) | Base font size |
| `--cs-font-size-xs` | `11px` | Small text (labels, timestamps) |
| `--cs-font-size-hero` | `18px` | Dashboard hero stat value |
| `--cs-font-size-input` | `14px` | Search input font size |
| `--cs-line-height` | `1.6` | Base line height |
| `--cs-line-height-code` | `1.4` | Code block line height |
| `--cs-letter-spacing-caps` | `0.5px` | Uppercase label letter spacing |

### Visual effects

| Variable | Default | Description |
|---|---|---|
| `--cs-thinking-opacity` | `0.55` | Thinking block resting opacity |
| `--cs-thinking-opacity-hover` | `0.85` | Thinking block hover opacity |
| `--cs-bar-opacity` | `0.75` | Tool usage bar opacity |

### Component dimensions

| Variable | Default | Description |
|---|---|---|
| `--cs-indicator-size` | `8px` | Tool status dot diameter |
| `--cs-bar-height` | `10px` | Stacked bar chart track height |
| `--cs-bar-height-sm` | `8px` | Tool usage bar height |
| `--cs-progress-height` | `12px` | Scrub bar height |
| `--cs-thumb-max-w` | `200px` | Image thumbnail max width |
| `--cs-thumb-max-h` | `150px` | Image thumbnail max height |

## What stays constant

These values are **not** themeable and always follow your Obsidian theme:

- **Body text colors** (`--text-normal`, `--text-muted`, `--text-faint`) -- legibility depends on your Obsidian theme
- **Semantic colors** (`--color-red`, `--color-green`, `--color-yellow`) -- error/success/warning meaning
- **Border radii** (`--radius-s`, `--radius-m`) -- structural, not decorative
- **Accessibility targets** (`min-height: 44px`) -- WCAG touch target size
- **Animation timings** -- interaction feel, not visual identity
