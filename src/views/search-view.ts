import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type ClaudeSessionsPlugin from '../main';
import type { Session, SessionListEntry } from '../types';
import { searchSessions, searchSessionsRanked, searchFile, searchFileRanked, resolveMatchTurn } from '../utils/session-search';
import type { SearchQuery, SearchMatch, SessionSearchResult } from '../utils/session-search';
import { readFileContent } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';
import { resolveSubAgentSessions } from '../parsers/claude-subagent';
import { makeClickable } from './render-helpers';
import { shortenPath } from '../utils/path-utils';
import { scanSessionDirs } from './session-browser-modal';
import { TimelineView } from './timeline-view';

export const VIEW_TYPE_SEARCH = 'claude-sessions-search';

const DEBOUNCE_MS = 300;
const VISIBLE_MATCHES_PER_SESSION = 5;
const SINGLE_SESSION_MAX_MATCHES = 100;
const SINGLE_SESSION_VISIBLE = 20;

type SearchMode = 'cross-session' | 'in-session';
type SortMode = 'relevance' | 'chronological';

interface SearchViewState {
	mode?: SearchMode;
	query?: string;
	roleFilter?: 'all' | 'user' | 'assistant';
	sortMode?: SortMode;
}

export class SearchView extends ItemView {
	private plugin: ClaudeSessionsPlugin;

	// Mode
	private mode: SearchMode = 'cross-session';
	private sortMode: SortMode = 'relevance';

	// Cross-session state
	private entries: SessionListEntry[] = [];
	private entriesLoaded = false;
	private cachedCrossResults: DocumentFragment | null = null;
	private cachedCrossProgress = '';
	private cachedCrossKey = '';

	// In-session state
	private trackedTimelineLeaf: WorkspaceLeaf | null = null;
	private trackedSession: Session | null = null;
	private trackedFilePath: string | null = null;

	// Search state
	private abortController: AbortController | null = null;
	private debounceTimer: number | null = null;

	// Active result tracking
	private activeRowEl: HTMLElement | null = null;

	// DOM refs
	private crossBtn!: HTMLElement;
	private inSessionBtn!: HTMLElement;
	private scopeLabel!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private roleSelect!: HTMLSelectElement;
	private sortBtn!: HTMLElement;
	private progressEl!: HTMLElement;
	private resultsEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeSessionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SEARCH;
	}

	getDisplayText(): string {
		return 'Session search';
	}

	getIcon(): string {
		return 'search';
	}

	onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('claude-sessions-search-view');

		// Mode toggle
		const modeRow = contentEl.createDiv({ cls: 'claude-sessions-search-mode-toggle' });

		this.crossBtn = modeRow.createEl('button', {
			cls: 'claude-sessions-search-mode-btn',
			text: 'All sessions',
			attr: { 'aria-label': 'Search all sessions', 'data-tooltip-position': 'bottom' },
		});
		this.crossBtn.addEventListener('click', () => this.setMode('cross-session'));

		this.inSessionBtn = modeRow.createEl('button', {
			cls: 'claude-sessions-search-mode-btn',
			text: 'Current session',
			attr: { 'aria-label': 'Search current session', 'data-tooltip-position': 'bottom' },
		});
		this.inSessionBtn.addEventListener('click', () => this.setMode('in-session'));

		// Scope label
		this.scopeLabel = contentEl.createDiv({ cls: 'claude-sessions-search-scope-label' });

		// Search input row
		const inputRow = contentEl.createDiv({ cls: 'claude-sessions-search-input-row' });

		this.inputEl = inputRow.createEl('input', {
			type: 'text',
			cls: 'claude-sessions-search-input',
			attr: {
				placeholder: 'Search...',
				'aria-label': 'Search query',
			},
		});

		this.roleSelect = inputRow.createEl('select', {
			cls: 'claude-sessions-search-role-select',
			attr: { 'aria-label': 'Filter by role' },
		});
		for (const [value, label] of [['all', 'All'], ['user', 'User'], ['assistant', 'Assistant']] as const) {
			this.roleSelect.createEl('option', { value, text: label });
		}

		this.sortBtn = inputRow.createEl('button', {
			cls: 'claude-sessions-search-sort-btn clickable-icon',
			attr: {
				'aria-label': 'Sort by relevance',
				'data-tooltip-position': 'top',
			},
		});
		this.syncSortUI();
		makeClickable(this.sortBtn, { label: 'Toggle sort mode' });
		this.sortBtn.addEventListener('click', () => {
			this.sortMode = this.sortMode === 'relevance' ? 'chronological' : 'relevance';
			this.syncSortUI();
			// Re-execute query with new sort
			if (this.inputEl.value.trim().length >= 2) {
				this.onQueryChange();
			}
		});

		// Progress
		this.progressEl = contentEl.createDiv({ cls: 'claude-sessions-search-progress' });

		// Results
		this.resultsEl = contentEl.createDiv({ cls: 'claude-sessions-search-results' });

		// Event handlers
		this.inputEl.addEventListener('input', () => this.onQueryChange());
		this.roleSelect.addEventListener('change', () => this.onQueryChange());

		// Keyboard navigation within results
		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				const first = this.resultsEl.querySelector<HTMLElement>('.claude-sessions-search-match-row');
				first?.focus();
			}
		});

		this.resultsEl.addEventListener('keydown', (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (!target.hasClass('claude-sessions-search-match-row')) return;

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

		// Apply initial mode
		this.syncModeUI();
		this.resolveTrackedSession();
		this.updateScopeLabel();

		requestAnimationFrame(() => this.inputEl.focus());
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.abortSearch();
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}
		return Promise.resolve();
	}

	getState(): Record<string, unknown> {
		return {
			mode: this.mode,
			query: this.inputEl?.value ?? '',
			roleFilter: this.roleSelect?.value ?? 'all',
			sortMode: this.sortMode,
		};
	}

	setState(state: SearchViewState): Promise<void> {
		if (state.mode) {
			this.mode = state.mode;
			this.syncModeUI();
		}
		if (state.sortMode) {
			this.sortMode = state.sortMode;
			this.syncSortUI();
		}
		if (state.roleFilter && this.roleSelect) {
			this.roleSelect.value = state.roleFilter;
		}
		if (state.query && this.inputEl) {
			this.inputEl.value = state.query;
		}
		this.resolveTrackedSession();
		this.updateScopeLabel();
		// Re-execute query if present
		if (this.inputEl?.value.trim().length >= 2) {
			this.onQueryChange();
		}
		return Promise.resolve();
	}

	// ── Public API ──

	setMode(mode: SearchMode): void {
		if (this.mode === mode) return;

		// Save cross-session results before leaving
		if (this.mode === 'cross-session' && this.resultsEl.childNodes.length > 0) {
			this.cachedCrossResults = document.createDocumentFragment();
			while (this.resultsEl.firstChild) {
				this.cachedCrossResults.appendChild(this.resultsEl.firstChild);
			}
			this.cachedCrossProgress = this.progressEl.getText();
		}

		this.mode = mode;
		this.abortSearch();
		this.resultsEl.empty();
		this.progressEl.setText('');
		this.activeRowEl = null;

		this.syncModeUI();
		this.resolveTrackedSession();
		this.updateScopeLabel();

		if (this.inputEl.value.trim().length >= 2) {
			// Restore cached cross-session results if query unchanged
			if (mode === 'cross-session' && this.cachedCrossResults && this.crossCacheKey() === this.cachedCrossKey) {
				this.resultsEl.appendChild(this.cachedCrossResults);
				this.cachedCrossResults = null;
				this.progressEl.setText(this.cachedCrossProgress);
			} else {
				this.onQueryChange();
			}
		}
	}

	onActiveLeafChanged(leaf: WorkspaceLeaf | null): void {
		// Ignore if the search view itself became active
		if (leaf?.view instanceof SearchView) return;

		if (this.mode !== 'in-session') return;

		if (leaf?.view instanceof TimelineView) {
			const session = leaf.view.getSession();
			if (session?.rawPath && session.rawPath !== this.trackedFilePath) {
				this.trackedTimelineLeaf = leaf;
				this.trackedSession = session;
				this.trackedFilePath = session.rawPath;
				this.updateScopeLabel();

				// Re-execute search against new session
				this.resultsEl.empty();
				this.progressEl.setText('');
				this.activeRowEl = null;
				if (this.inputEl.value.trim().length >= 2) {
					this.onQueryChange();
				}
			}
		}
	}

	// ── Mode UI ──

	private syncModeUI(): void {
		if (!this.crossBtn) return;
		this.crossBtn.toggleClass('active', this.mode === 'cross-session');
		this.inSessionBtn.toggleClass('active', this.mode === 'in-session');
		this.inputEl.setAttribute('placeholder',
			this.mode === 'in-session' ? 'Search in session...' : 'Search across sessions...');
	}

	private syncSortUI(): void {
		if (!this.sortBtn) return;
		const isRelevance = this.sortMode === 'relevance';
		setIcon(this.sortBtn, isRelevance ? 'arrow-up-narrow-wide' : 'clock');
		this.sortBtn.setAttribute('aria-label', isRelevance ? 'Sorted by relevance' : 'Sorted chronologically');
		this.sortBtn.toggleClass('active', isRelevance);
	}

	private resolveTrackedSession(): void {
		if (this.mode !== 'in-session') return;
		// Find the active timeline view
		const timelineView = this.app.workspace.getActiveViewOfType(TimelineView);
		if (timelineView) {
			const session = timelineView.getSession();
			if (session?.rawPath) {
				this.trackedTimelineLeaf = timelineView.leaf;
				this.trackedSession = session;
				this.trackedFilePath = session.rawPath;
				return;
			}
		}
		// Fallback: search all timeline leaves for one with a session
		if (!this.trackedSession) {
			const leaves = this.app.workspace.getLeavesOfType('claude-sessions-timeline');
			for (const l of leaves) {
				if (l.view instanceof TimelineView) {
					const s = l.view.getSession();
					if (s?.rawPath) {
						this.trackedTimelineLeaf = l;
						this.trackedSession = s;
						this.trackedFilePath = s.rawPath;
						return;
					}
				}
			}
		}
	}

	private updateScopeLabel(): void {
		if (!this.scopeLabel) return;
		if (this.mode === 'cross-session') {
			this.scopeLabel.setText(this.entriesLoaded
				? `All sessions (${this.entries.length})`
				: 'All sessions');
		} else {
			if (this.trackedSession) {
				this.scopeLabel.setText(`Searching in: ${this.trackedSession.metadata.project}`);
			} else {
				this.scopeLabel.setText('No session open');
			}
		}
	}

	// ── Query handling ──

	private onQueryChange(): void {
		this.abortSearch();

		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}

		const text = this.inputEl.value.trim();
		if (text.length < 2) {
			this.resultsEl.empty();
			this.progressEl.setText(text.length === 1 ? 'Type at least 2 characters...' : '');
			this.activeRowEl = null;
			return;
		}

		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			if (this.mode === 'in-session') {
				void this.executeInSessionSearch(text);
			} else {
				void this.executeCrossSessionSearch(text);
			}
		}, DEBOUNCE_MS);
	}

	private abortSearch(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	// ── In-session search ──

	private async executeInSessionSearch(text: string): Promise<void> {
		this.abortSearch();
		this.resultsEl.empty();
		this.activeRowEl = null;

		if (!this.trackedFilePath || !this.trackedSession) {
			this.progressEl.setText('No session open.');
			return;
		}

		const controller = new AbortController();
		this.abortController = controller;

		const query: SearchQuery = {
			text,
			caseSensitive: false,
			roleFilter: this.roleSelect.value as 'all' | 'user' | 'assistant',
		};

		this.progressEl.setText('Searching...');

		const searchFn = this.sortMode === 'relevance' ? searchFileRanked : searchFile;
		const { matches, totalMatches } = await searchFn(
			this.trackedFilePath, query, SINGLE_SESSION_MAX_MATCHES, controller.signal,
		);

		if (controller.signal.aborted) return;

		if (matches.length === 0) {
			this.progressEl.setText('No matches found.');
			return;
		}

		const countText = totalMatches === matches.length
			? `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`
			: `${totalMatches} matches (showing ${matches.length})`;
		this.progressEl.setText(countText);

		const visibleCount = Math.min(SINGLE_SESSION_VISIBLE, matches.length);
		for (let i = 0; i < visibleCount; i++) {
			this.renderInSessionMatchRow(matches[i], query);
		}

		if (matches.length > SINGLE_SESSION_VISIBLE) {
			const remaining = matches.length - SINGLE_SESSION_VISIBLE;
			const moreBtn = this.resultsEl.createDiv({
				cls: 'claude-sessions-search-more-btn',
				text: `+${remaining} more`,
			});
			makeClickable(moreBtn, { label: `Show ${remaining} more matches` });
			moreBtn.addEventListener('click', () => {
				moreBtn.remove();
				for (let i = SINGLE_SESSION_VISIBLE; i < matches.length; i++) {
					this.renderInSessionMatchRow(matches[i], query);
				}
			});
		}
	}

	private renderInSessionMatchRow(match: SearchMatch, query: SearchQuery): void {
		const session = this.trackedSession;
		if (!session) return;

		const row = this.resultsEl.createDiv({ cls: 'claude-sessions-search-match-row' });
		makeClickable(row, { label: 'Go to match' });

		const resolvedTurn = resolveMatchTurn(match, session.turns);

		// Turn label
		row.createSpan({ cls: 'claude-sessions-search-match-turn', text: `#${resolvedTurn + 1}` });

		// Score indicator (only in relevance mode)
		if (match.score !== undefined) {
			const pct = Math.min(100, Math.round(match.score * 20));
			const scoreEl = row.createSpan({
				cls: 'claude-sessions-search-match-score',
				attr: { 'aria-label': `Relevance: ${pct}%` },
			});
			const bar = scoreEl.createSpan({ cls: 'claude-sessions-search-score-bar' });
			bar.style.setProperty('--score-pct', `${pct}%`);
		}

		// Role + type
		const meta = row.createSpan({ cls: 'claude-sessions-search-match-meta' });
		const roleIcon = match.role === 'user' ? 'U' : 'A';
		const typeLabel = match.toolName || match.blockType;
		meta.setText(`${roleIcon} · ${typeLabel}`);

		if (match.timestamp) {
			const ts = new Date(match.timestamp);
			if (!isNaN(ts.getTime())) {
				const time = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
				row.createSpan({ cls: 'claude-sessions-search-match-time', text: time });
			}
		}

		// Context snippet
		const snippet = row.createDiv({ cls: 'claude-sessions-search-snippet' });
		if (match.contextBefore) snippet.createSpan({ text: match.contextBefore });
		snippet.createEl('mark', { text: match.matchText });
		if (match.contextAfter) snippet.createSpan({ text: match.contextAfter });

		row.addEventListener('click', () => {
			this.setActiveRow(row);
			this.navigateToInSessionMatch(resolvedTurn, query.text, match.contextBefore);
		});
	}

	private navigateToInSessionMatch(turnIndex: number, query: string, matchContext?: string): void {
		if (!this.trackedTimelineLeaf) return;
		const view = this.trackedTimelineLeaf.view;
		if (view instanceof TimelineView) {
			// Reveal the timeline leaf so the user sees the result
			void this.app.workspace.revealLeaf(this.trackedTimelineLeaf);
			view.navigateToMatch(turnIndex, query, matchContext);
		}
	}

	// ── Cross-session search ──

	private crossCacheKey(): string {
		return `${this.inputEl.value.trim()}\0${this.roleSelect.value}\0${this.sortMode}`;
	}

	private async executeCrossSessionSearch(text: string): Promise<void> {
		this.abortSearch();
		this.resultsEl.empty();
		this.activeRowEl = null;

		// Lazy-load entries
		if (!this.entriesLoaded) {
			this.progressEl.setText('Scanning session directories...');
			const result = await scanSessionDirs(this.plugin);
			this.entries = result.entries;
			this.entriesLoaded = true;
			this.updateScopeLabel();
		}

		if (this.entries.length === 0) {
			this.progressEl.setText('No sessions found. Check session directories in settings.');
			return;
		}

		const controller = new AbortController();
		this.abortController = controller;

		this.cachedCrossKey = this.crossCacheKey();
		this.cachedCrossResults = null;

		const query: SearchQuery = {
			text,
			caseSensitive: false,
			roleFilter: this.roleSelect.value as 'all' | 'user' | 'assistant',
		};

		let resultCount = 0;

		const searchFn = this.sortMode === 'relevance' ? searchSessionsRanked : searchSessions;
		void searchFn(
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
		const group = this.resultsEl.createDiv({ cls: 'claude-sessions-search-session-group' });

		// Session header
		const header = group.createDiv({ cls: 'claude-sessions-search-session-header' });
		header.createSpan({ cls: 'claude-sessions-search-session-project', text: result.entry.project });
		if (result.entry.date) {
			header.createSpan({ cls: 'claude-sessions-search-session-date', text: result.entry.date });
		}
		const pathText = result.entry.cwd ? shortenPath(result.entry.cwd) : '';
		if (pathText) {
			header.createDiv({ cls: 'claude-sessions-search-session-path', text: pathText });
		}

		const countText = result.totalMatches === result.matches.length
			? `${result.totalMatches} match${result.totalMatches !== 1 ? 'es' : ''}`
			: `${result.totalMatches} matches (showing ${result.matches.length})`;
		header.createSpan({ cls: 'claude-sessions-search-match-count', text: countText });

		// Match rows
		const visibleCount = Math.min(VISIBLE_MATCHES_PER_SESSION, result.matches.length);
		for (let i = 0; i < visibleCount; i++) {
			this.renderMultiMatchRow(group, result, result.matches[i], query);
		}

		// "+N more" expander
		if (result.matches.length > VISIBLE_MATCHES_PER_SESSION) {
			const remaining = result.matches.length - VISIBLE_MATCHES_PER_SESSION;
			const moreBtn = group.createDiv({
				cls: 'claude-sessions-search-more-btn',
				text: `+${remaining} more`,
			});
			makeClickable(moreBtn, { label: `Show ${remaining} more matches` });
			moreBtn.addEventListener('click', () => {
				moreBtn.remove();
				for (let i = VISIBLE_MATCHES_PER_SESSION; i < result.matches.length; i++) {
					this.renderMultiMatchRow(group, result, result.matches[i], query);
				}
			});
		}
	}

	private renderMultiMatchRow(
		container: HTMLElement,
		result: SessionSearchResult,
		match: SearchMatch,
		query: SearchQuery,
	): void {
		const row = container.createDiv({ cls: 'claude-sessions-search-match-row' });
		makeClickable(row, { label: 'Open match in session' });

		// Score indicator (only in relevance mode)
		if (match.score !== undefined) {
			const pct = Math.min(100, Math.round(match.score * 20));
			const scoreEl = row.createSpan({
				cls: 'claude-sessions-search-match-score',
				attr: { 'aria-label': `Relevance: ${pct}%` },
			});
			const bar = scoreEl.createSpan({ cls: 'claude-sessions-search-score-bar' });
			bar.style.setProperty('--score-pct', `${pct}%`);
		}

		// Role + type label
		const meta = row.createSpan({ cls: 'claude-sessions-search-match-meta' });
		const roleIcon = match.role === 'user' ? 'U' : 'A';
		const typeLabel = match.toolName || match.blockType;
		meta.setText(`${roleIcon} · ${typeLabel}`);

		if (match.timestamp) {
			const ts = new Date(match.timestamp);
			if (!isNaN(ts.getTime())) {
				const time = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
				row.createSpan({ cls: 'claude-sessions-search-match-time', text: time });
			}
		}

		// Context snippet with highlighted match
		const snippet = row.createDiv({ cls: 'claude-sessions-search-snippet' });
		if (match.contextBefore) snippet.createSpan({ text: match.contextBefore });
		snippet.createEl('mark', { text: match.matchText });
		if (match.contextAfter) snippet.createSpan({ text: match.contextAfter });

		// Click opens session at turn
		row.addEventListener('click', () => {
			this.setActiveRow(row);
			void this.openCrossSessionResult(result.entry, match, query.text);
		});
	}

	private async openCrossSessionResult(entry: SessionListEntry, match: SearchMatch, query: string): Promise<void> {
		try {
			const content = await readFileContent(entry.path);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format.');
				return;
			}
			const session = parser.parse(content, entry.path);
			await resolveSubAgentSessions(session, readFileContent);
			const turnIndex = resolveMatchTurn(match, session.turns);
			await this.plugin.openSession(session, turnIndex, query, match.contextBefore);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}

	// ── Active row tracking ──

	private setActiveRow(row: HTMLElement): void {
		if (this.activeRowEl) {
			this.activeRowEl.removeClass('active');
		}
		row.addClass('active');
		this.activeRowEl = row;
	}
}

/** Find the next .claude-sessions-search-match-row after the current one. */
function nextFocusable(current: HTMLElement, container: HTMLElement): HTMLElement | null {
	const all = Array.from(container.querySelectorAll('.claude-sessions-search-match-row'));
	const idx = all.indexOf(current);
	return idx >= 0 && idx < all.length - 1 ? all[idx + 1] as HTMLElement : null;
}

/** Find the previous .claude-sessions-search-match-row before the current one. */
function prevFocusable(current: HTMLElement, container: HTMLElement): HTMLElement | null {
	const all = Array.from(container.querySelectorAll('.claude-sessions-search-match-row'));
	const idx = all.indexOf(current);
	return idx > 0 ? all[idx - 1] as HTMLElement : null;
}
