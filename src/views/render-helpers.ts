import { App, Component, setIcon } from 'obsidian';
import type { PluginSettings, HookSuccessEvent, AsyncHookResponseEvent, HookPermissionDecisionEvent } from '../types';

/** Hook events that can be displayed inline with tool calls. */
export type InlineHookEvent = HookSuccessEvent | AsyncHookResponseEvent | HookPermissionDecisionEvent;

/** Shared context passed to all renderer functions. */
export interface RenderContext {
	app: App;
	component: Component;
	settings: PluginSettings;
	/** Map of toolUseId → InlineHookEvent[] for inline hook indicators */
	hookEventsByToolId?: Map<string, InlineHookEvent[]>;
}

export const COLLAPSE_THRESHOLD = 10;

/** Map file extensions to markdown fence language identifiers. */
const EXT_TO_LANG: Record<string, string> = {
	ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
	py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
	java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
	swift: 'swift', m: 'objectivec',
	sh: 'bash', zsh: 'bash', bash: 'bash', fish: 'fish',
	json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
	xml: 'xml', html: 'html', css: 'css', scss: 'scss', less: 'less',
	sql: 'sql', graphql: 'graphql', gql: 'graphql',
	md: 'markdown', mdx: 'mdx', tex: 'latex',
	dockerfile: 'dockerfile', makefile: 'makefile',
	lua: 'lua', r: 'r', pl: 'perl', php: 'php', ex: 'elixir', erl: 'erlang',
	hs: 'haskell', ml: 'ocaml', scala: 'scala', clj: 'clojure',
	vue: 'vue', svelte: 'svelte', astro: 'astro',
	tf: 'hcl', hcl: 'hcl', nix: 'nix', zig: 'zig', v: 'v',
};

/** Strip `cat -n` style line numbers: digits + arrow/tab separator */
export function stripLineNumbers(text: string): string {
	return text.replace(/^\d+[\u2192\t]/gm, '');
}

/** Extract language from a file path's extension. */
export function langFromPath(filePath: string): string {
	const basename = filePath.split('/').pop() ?? '';
	const lowerBase = basename.toLowerCase();
	if (lowerBase === 'makefile') return 'makefile';
	if (lowerBase === 'dockerfile') return 'dockerfile';
	const ext = basename.split('.').pop()?.toLowerCase() ?? '';
	return EXT_TO_LANG[ext] ?? '';
}

/** Convert full model ID to short display name, e.g. "claude-opus-4-6-20250514" → "opus 4.6". */
export function shortModelName(model: string): string {
	// New format: claude-opus-4-6[-date]
	let m = model.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
	if (m) return `${m[1]} ${m[2]}.${m[3]}`;
	// Old format: claude-3-5-sonnet[-date]
	m = model.match(/claude-(\d+)-(\d+)-(opus|sonnet|haiku)/);
	if (m) return `${m[3]} ${m[1]}.${m[2]}`;
	return model;
}

/** Return a backtick fence string (at least 3) that won't collide with content. */
export function fence(content: string, lang = ''): string {
	let max = 2;
	const re = /`{3,}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		if (m[0].length > max) max = m[0].length;
	}
	const ticks = '`'.repeat(max + 1);
	return ticks + lang + '\n' + content + '\n' + ticks;
}

/**
 * Drop standalone code-fence marker lines.
 *
 * AskUserQuestion previews arrive in three shapes: bare ASCII, fully fenced,
 * and fenced art followed by trailing prose. All three render as preformatted
 * text, so the markers carry no meaning and would show up literally. Only
 * lines that are nothing but a fence are removed, so content keeps its exact
 * alignment. A preview deliberately showing a fence as content would lose it —
 * no such case exists in practice, and mangled ASCII art is the worse failure.
 */
export function stripFenceMarkers(text: string): string {
	const lines = text.replace(/\s+$/, '').split('\n');
	const kept = lines.filter(l => !/^\s*(?:`{3,}|~{3,})[^\s`~]*\s*$/.test(l));
	return kept.length === lines.length ? text : kept.join('\n');
}

/**
 * Ensure blank line before GFM tables (CommonMark requires it for block-level parsing),
 * and defuse a leading `---` so Obsidian doesn't read the block as YAML frontmatter.
 */
export function normalizeMarkdown(text: string): string {
	const withTables = text.replace(/^([^|\n][^\n]*)\n(\|[^\n]+\|\s*\n\|[-:| ]+\|)/gm, '$1\n\n$2');
	// A text block opening with `---` is a thematic break, but MarkdownRenderer treats
	// it as a frontmatter delimiter and swallows everything up to the next `---` —
	// rendering the turn blank. `***` is the equivalent break with no such ambiguity.
	return withTables.replace(/^[ \t]*---[ \t]*(?=\n|$)/, '***');
}

/** Make a clickable div keyboard-accessible: tabindex, role, aria attrs, Enter/Space handler. */
export function makeClickable(el: HTMLElement, opts: {
	label?: string; role?: string; expanded?: boolean;
}): void {
	el.setAttribute('tabindex', '0');
	el.setAttribute('role', opts.role ?? 'button');
	if (opts.label) el.setAttribute('aria-label', opts.label);
	if (opts.expanded !== undefined) el.setAttribute('aria-expanded', String(opts.expanded));
	el.addEventListener('keydown', (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			el.click();
		}
	});
}

export function formatElapsed(ms: number): string {
	if (ms <= 0) return '0:00';
	const totalSec = Math.round(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}

/** Add a copy-to-clipboard button with icon swap feedback. */
export function addCopyButton(container: HTMLElement, text: string, label: string, cls = 'claude-sessions-summary-copy'): void {
	const btn = container.createEl('button', {
		cls: `${cls} clickable-icon`,
		attr: { 'aria-label': label, 'data-tooltip-position': 'top', 'data-copy-text': text },
	});
	setIcon(btn, 'copy');
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		void navigator.clipboard.writeText(text);
		setIcon(btn, 'check');
		window.setTimeout(() => setIcon(btn, 'copy'), 1500);
	});
}
