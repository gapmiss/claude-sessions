import { App, Component, setIcon } from 'obsidian';
import type { PluginSettings } from '../types';

/** Shared context passed to all renderer functions. */
export interface RenderContext {
	app: App;
	component: Component;
	settings: PluginSettings;
}

export const COLLAPSE_THRESHOLD = 10;

/** Map file extensions to markdown fence language identifiers. */
const EXT_TO_LANG: Record<string, string> = {
	ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
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

/** Strip `cat -n` style line numbers: leading whitespace + digits + arrow/tab */
export function stripLineNumbers(text: string): string {
	return text.replace(/^[ \t]*\d+[\u2192\t][ \t]?/gm, '');
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

/** Ensure blank line before GFM tables (CommonMark requires it for block-level parsing). */
export function normalizeMarkdown(text: string): string {
	return text.replace(/^([^|\n][^\n]*)\n(\|[^\n]+\|\s*\n\|[-:| ]+\|)/gm, '$1\n\n$2');
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
		navigator.clipboard.writeText(text);
		setIcon(btn, 'check');
		setTimeout(() => setIcon(btn, 'copy'), 1500);
	});
}
