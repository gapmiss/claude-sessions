import { App, Modal, Notice } from 'obsidian';
import type AgentSessionsPlugin from '../main';
import type { SessionListEntry } from '../types';
import { searchSessions, SearchQuery, SessionSearchResult } from '../utils/session-search';
import { readFileContent } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';
import { resolveSubAgentSessions } from '../parsers/claude-subagent';
import { makeClickable } from './render-helpers';
import { shortenPath } from '../utils/path-utils';

const DEBOUNCE_MS = 300;
const VISIBLE_MATCHES_PER_SESSION = 5;

export class SessionSearchModal extends Modal {
	private plugin: AgentSessionsPlugin;
	private entries: SessionListEntry[];
	private abortController: AbortController | null = null;
	private debounceTimer: number | null = null;

	private inputEl!: HTMLInputElement;
	private roleSelect!: HTMLSelectElement;
	private progressEl!: HTMLElement;
	private resultsEl!: HTMLElement;

	constructor(app: App, plugin: AgentSessionsPlugin, entries: SessionListEntry[]) {
		super(app);
		this.plugin = plugin;
		this.entries = entries;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('agent-sessions-search-modal');

		// ── Search input row ──
		const inputRow = contentEl.createDiv({ cls: 'agent-sessions-search-input-row' });

		this.inputEl = inputRow.createEl('input', {
			type: 'text',
			cls: 'agent-sessions-search-input',
			attr: { placeholder: 'Search across sessions...', 'aria-label': 'Search query' },
		});

		this.roleSelect = inputRow.createEl('select', {
			cls: 'agent-sessions-search-role-select',
			attr: { 'aria-label': 'Filter by role' },
		});
		for (const [value, label] of [['all', 'All'], ['user', 'User'], ['assistant', 'Assistant']] as const) {
			this.roleSelect.createEl('option', { value, text: label });
		}

		// ── Progress ──
		this.progressEl = contentEl.createDiv({ cls: 'agent-sessions-search-progress' });

		// ── Results ──
		this.resultsEl = contentEl.createDiv({ cls: 'agent-sessions-search-results' });

		// ── Event handlers ──
		this.inputEl.addEventListener('input', () => this.onQueryChange());
		this.roleSelect.addEventListener('change', () => this.onQueryChange());

		// Keyboard navigation within results
		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				const first = this.resultsEl.querySelector('.agent-sessions-search-match-row') as HTMLElement | null;
				first?.focus();
			}
		});

		this.resultsEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (!target.hasClass('agent-sessions-search-match-row')) return;

			if (e.key === 'ArrowDown') {
				e.preventDefault();
				const next = nextFocusable(target, this.resultsEl);
				next?.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				const prev = prevFocusable(target, this.resultsEl);
				if (prev) prev.focus();
				else this.inputEl.focus();
			} else if (e.key === 'Enter') {
				e.preventDefault();
				target.click();
			}
		});

		// Auto-focus
		requestAnimationFrame(() => this.inputEl.focus());
	}

	onClose(): void {
		this.abortSearch();
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}
	}

	private onQueryChange(): void {
		this.abortSearch();

		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}

		const text = this.inputEl.value.trim();
		if (text.length < 2) {
			this.resultsEl.empty();
			this.progressEl.setText(text.length === 1 ? 'Type at least 2 characters...' : '');
			return;
		}

		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.executeSearch(text);
		}, DEBOUNCE_MS);
	}

	private abortSearch(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	private executeSearch(text: string): void {
		this.abortSearch();
		this.resultsEl.empty();

		const controller = new AbortController();
		this.abortController = controller;

		const query: SearchQuery = {
			text,
			caseSensitive: false,
			roleFilter: this.roleSelect.value as 'all' | 'user' | 'assistant',
		};

		let resultCount = 0;

		searchSessions(
			this.entries,
			query,
			(result) => {
				if (controller.signal.aborted) return;
				resultCount++;
				this.renderSessionResult(result, query);
			},
			(searched, total) => {
				if (controller.signal.aborted) return;
				if (searched < total) {
					this.progressEl.setText(`Searching ${searched}/${total} sessions... (${resultCount} with matches)`);
				} else {
					this.progressEl.setText(
						resultCount > 0
							? `Done — ${resultCount} session${resultCount !== 1 ? 's' : ''} with matches`
							: 'No matches found.'
					);
				}
			},
			controller.signal,
		);
	}

	private renderSessionResult(result: SessionSearchResult, query: SearchQuery): void {
		const group = this.resultsEl.createDiv({ cls: 'agent-sessions-search-session-group' });

		// Session header
		const header = group.createDiv({ cls: 'agent-sessions-search-session-header' });
		header.createSpan({ cls: 'agent-sessions-search-session-project', text: result.entry.project });
		if (result.entry.date) {
			header.createSpan({ cls: 'agent-sessions-search-session-date', text: result.entry.date });
		}
		const pathText = result.entry.cwd ? shortenPath(result.entry.cwd) : '';
		if (pathText) {
			header.createDiv({ cls: 'agent-sessions-search-session-path', text: pathText });
		}

		const countText = result.totalMatches === result.matches.length
			? `${result.totalMatches} match${result.totalMatches !== 1 ? 'es' : ''}`
			: `${result.totalMatches} matches (showing ${result.matches.length})`;
		header.createSpan({ cls: 'agent-sessions-search-match-count', text: countText });

		// Match rows
		const visibleCount = Math.min(VISIBLE_MATCHES_PER_SESSION, result.matches.length);
		for (let i = 0; i < visibleCount; i++) {
			this.renderMatchRow(group, result, result.matches[i], query);
		}

		// "+N more" expander
		if (result.matches.length > VISIBLE_MATCHES_PER_SESSION) {
			const remaining = result.matches.length - VISIBLE_MATCHES_PER_SESSION;
			const moreBtn = group.createDiv({
				cls: 'agent-sessions-search-more-btn',
				text: `+${remaining} more`,
			});
			makeClickable(moreBtn, { label: `Show ${remaining} more matches` });
			moreBtn.addEventListener('click', () => {
				moreBtn.remove();
				for (let i = VISIBLE_MATCHES_PER_SESSION; i < result.matches.length; i++) {
					this.renderMatchRow(group, result, result.matches[i], query);
				}
			});
		}
	}

	private renderMatchRow(
		container: HTMLElement,
		result: SessionSearchResult,
		match: import('../utils/session-search').SearchMatch,
		query: SearchQuery,
	): void {
		const row = container.createDiv({ cls: 'agent-sessions-search-match-row' });
		makeClickable(row, { label: `Open match in session` });

		// Role + type label
		const meta = row.createSpan({ cls: 'agent-sessions-search-match-meta' });
		const roleIcon = match.role === 'user' ? 'U' : 'A';
		const typeLabel = match.toolName || match.blockType;
		meta.setText(`${roleIcon} · ${typeLabel}`);

		if (match.timestamp) {
			const ts = new Date(match.timestamp);
			if (!isNaN(ts.getTime())) {
				const time = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
				row.createSpan({ cls: 'agent-sessions-search-match-time', text: time });
			}
		}

		// Context snippet with highlighted match
		const snippet = row.createDiv({ cls: 'agent-sessions-search-snippet' });
		if (match.contextBefore) {
			snippet.createSpan({ text: match.contextBefore });
		}
		snippet.createEl('mark', { text: match.matchText });
		if (match.contextAfter) {
			snippet.createSpan({ text: match.contextAfter });
		}

		// Click opens session at turn
		row.addEventListener('click', () => {
			this.openResult(result.entry, match.turnIndex);
		});
	}

	private async openResult(entry: SessionListEntry, turnIndex: number): Promise<void> {
		try {
			new Notice('Loading session...');
			const content = await readFileContent(entry.path);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format.');
				return;
			}
			const session = parser.parse(content, entry.path);
			await resolveSubAgentSessions(session, readFileContent);
			await this.plugin.openSession(session, turnIndex);
			this.close();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}
}

/** Find the next .agent-sessions-search-match-row after the current one. */
function nextFocusable(current: HTMLElement, container: HTMLElement): HTMLElement | null {
	const all = Array.from(container.querySelectorAll('.agent-sessions-search-match-row'));
	const idx = all.indexOf(current);
	return idx >= 0 && idx < all.length - 1 ? all[idx + 1] as HTMLElement : null;
}

/** Find the previous .agent-sessions-search-match-row before the current one. */
function prevFocusable(current: HTMLElement, container: HTMLElement): HTMLElement | null {
	const all = Array.from(container.querySelectorAll('.agent-sessions-search-match-row'));
	const idx = all.indexOf(current);
	return idx > 0 ? all[idx - 1] as HTMLElement : null;
}
