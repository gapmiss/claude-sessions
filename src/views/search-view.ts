import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type ClaudeSessionsPlugin from '../main';
import type { Session, SessionListEntry } from '../types';
import { searchSessions, searchSessionsRanked, searchTurns, searchTurnsRanked, resolveMatchTurn } from '../utils/session-search';
import type { SearchQuery, SearchMatch, InSessionMatch, SessionSearchResult } from '../utils/session-search';
import { readFileContent, listDirectoryFiles } from '../utils/streaming-reader';
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

	// Filter state
	private roleFilter: 'all' | 'user' | 'assistant' = 'all';

	// DOM refs
	private crossBtn!: HTMLElement;
	private inSessionBtn!: HTMLElement;
	private scopeLabel!: HTMLElement;
	private refreshBtn!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private clearBtn!: HTMLElement;
	private optionsBtn!: HTMLElement;
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

		// Scope label with refresh button
		const scopeRow = contentEl.createDiv({ cls: 'claude-sessions-search-scope-row' });
		this.scopeLabel = scopeRow.createDiv({ cls: 'claude-sessions-search-scope-label' });
		this.refreshBtn = scopeRow.createEl('button', {
			cls: 'claude-sessions-search-refresh-btn clickable-icon',
			attr: { 'aria-label': 'Refresh session list' },
		});
		setIcon(this.refreshBtn, 'refresh-cw');
		this.refreshBtn.addEventListener('click', () => this.refreshEntries());

		// Search input row
		const inputRow = contentEl.createDiv({ cls: 'claude-sessions-search-input-row' });

		// Input container with search icon, input, and clear button
		const inputContainer = inputRow.createDiv({ cls: 'claude-sessions-search-input-container' });
		const searchIcon = inputContainer.createSpan({ cls: 'claude-sessions-search-icon' });
		setIcon(searchIcon, 'search');

		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			cls: 'claude-sessions-search-input',
			attr: {
				placeholder: 'Search...',
				'aria-label': 'Search query',
			},
		});

		this.clearBtn = inputContainer.createEl('button', {
			cls: 'claude-sessions-search-clear-btn',
			attr: {
				'aria-label': 'Clear search',
				'data-tooltip-position': 'top',
			},
		});
		setIcon(this.clearBtn, 'x');
		this.clearBtn.addEventListener('click', () => {
			this.inputEl.value = '';
			this.syncClearButton();
			this.onQueryChange();
			this.inputEl.focus();
		});

		// Options menu button (role filter + sort mode)
		this.optionsBtn = inputRow.createEl('button', {
			cls: 'claude-sessions-search-options-btn clickable-icon',
			attr: {
				'aria-label': 'Search options',
				'data-tooltip-position': 'top',
			},
		});
		setIcon(this.optionsBtn, 'more-vertical');
		this.optionsBtn.addEventListener('click', (e) => this.showOptionsMenu(e));

		// Progress
		this.progressEl = contentEl.createDiv({ cls: 'claude-sessions-search-progress' });

		// Results
		this.resultsEl = contentEl.createDiv({ cls: 'claude-sessions-search-results' });

		// Event handlers
		this.inputEl.addEventListener('input', () => {
			this.syncClearButton();
			this.onQueryChange();
		});

		// Initial clear button state
		this.syncClearButton();

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
			roleFilter: this.roleFilter,
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
		}
		if (state.roleFilter) {
			this.roleFilter = state.roleFilter;
		}
		if (state.query && this.inputEl) {
			this.inputEl.value = state.query;
			this.syncClearButton();
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

	/** Invalidate cached entries, forcing a re-scan on next cross-session search. */
	refreshEntries(): void {
		this.entriesLoaded = false;
		this.entries = [];
		this.cachedCrossResults = null;
		this.cachedCrossKey = '';
		this.updateScopeLabel();
		// Re-run search if in cross-session mode with active query
		if (this.mode === 'cross-session' && this.inputEl?.value.trim().length >= 2) {
			this.onQueryChange();
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
		// Refresh button only visible in cross-session mode
		if (this.refreshBtn) {
			this.refreshBtn.style.display = this.mode === 'cross-session' ? '' : 'none';
		}
	}

	private syncClearButton(): void {
		if (!this.clearBtn) return;
		const hasContent = this.inputEl.value.length > 0;
		this.clearBtn.toggleClass('is-visible', hasContent);
	}

	private showOptionsMenu(e: MouseEvent): void {
		const menu = new Menu();

		// Role filter section
		menu.addItem((item) => {
			item.setTitle('Filter by role')
				.setIcon('filter')
				.setDisabled(true);
		});

		for (const [value, label] of [['all', 'All roles'], ['user', 'User only'], ['assistant', 'Assistant only']] as const) {
			menu.addItem((item) => {
				item.setTitle(label)
					.setChecked(this.roleFilter === value)
					.onClick(() => {
						this.roleFilter = value;
						if (this.inputEl.value.trim().length >= 2) {
							this.onQueryChange();
						}
					});
			});
		}

		menu.addSeparator();

		// Sort mode section
		menu.addItem((item) => {
			item.setTitle('Sort by')
				.setIcon('arrow-up-down')
				.setDisabled(true);
		});

		menu.addItem((item) => {
			item.setTitle('Relevance')
				.setIcon('star')
				.setChecked(this.sortMode === 'relevance')
				.onClick(() => {
					this.sortMode = 'relevance';
					if (this.inputEl.value.trim().length >= 2) {
						this.onQueryChange();
					}
				});
		});

		menu.addItem((item) => {
			item.setTitle('Chronological')
				.setIcon('clock')
				.setChecked(this.sortMode === 'chronological')
				.onClick(() => {
					this.sortMode = 'chronological';
					if (this.inputEl.value.trim().length >= 2) {
						this.onQueryChange();
					}
				});
		});

		menu.showAtMouseEvent(e);
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
				const displayName = this.trackedSession.metadata.customTitle || this.trackedSession.metadata.project;
				this.scopeLabel.setText(`Session: ${displayName}`);
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

	private executeInSessionSearch(text: string): void {
		this.abortSearch();
		this.resultsEl.empty();
		this.activeRowEl = null;

		if (!this.trackedSession) {
			this.progressEl.setText('No session open.');
			return;
		}

		const query: SearchQuery = {
			text,
			caseSensitive: false,
			roleFilter: this.roleFilter,
		};

		// Turn-based search is synchronous over in-memory turns — no signal needed.
		const searchFn = this.sortMode === 'relevance' ? searchTurnsRanked : searchTurns;
		const { matches, totalMatches } = searchFn(
			this.trackedSession.turns, query, SINGLE_SESSION_MAX_MATCHES,
		);

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
			this.renderInSessionMatchRow(matches[i]);
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
					this.renderInSessionMatchRow(matches[i]);
				}
			});
		}
	}

	private renderInSessionMatchRow(match: InSessionMatch): void {
		const session = this.trackedSession;
		if (!session) return;

		const row = this.resultsEl.createDiv({ cls: 'claude-sessions-search-match-row' });
		makeClickable(row, { label: 'Go to match' });

		// Turn-based search returns the precise turn index — no re-resolution needed.
		row.createSpan({ cls: 'claude-sessions-search-match-turn', text: `#${match.turnIndex + 1}` });

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
			this.navigateToInSessionMatch(match);
		});
	}

	private navigateToInSessionMatch(match: InSessionMatch): void {
		if (!this.trackedTimelineLeaf) return;
		const view = this.trackedTimelineLeaf.view;
		if (view instanceof TimelineView) {
			// Reveal the timeline leaf so the user sees the result
			void this.app.workspace.revealLeaf(this.trackedTimelineLeaf);
			view.navigateToMatch(match.turnIndex, match.contentBlockIndex, match.matchText, match.occurrenceInBlock);
		}
	}

	// ── Cross-session search ──

	private crossCacheKey(): string {
		return `${this.inputEl.value.trim()}\0${this.roleFilter}\0${this.sortMode}`;
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
			roleFilter: this.roleFilter,
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
		const displayName = result.entry.customTitle || result.entry.project;
		header.createSpan({ cls: 'claude-sessions-search-session-project', text: displayName });
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
			await resolveSubAgentSessions(session, readFileContent, listDirectoryFiles);
			const turnIndex = resolveMatchTurn(match, session.turns);

			// Re-resolve the streaming match to precise (contentBlockIndex, charOffset, charLength)
			// coordinates using the parsed turns. Prefer matches in the streaming-resolved turn,
			// disambiguated by contextBefore when the turn has multiple hits (Gotcha C).
			const { matches: precise } = searchTurns(session.turns, { text: query, caseSensitive: false });
			const best = pickBestMatch(precise, turnIndex, match.contextBefore);
			const highlight = best
				? { contentBlockIndex: best.contentBlockIndex, text: best.matchText, occurrenceInBlock: best.occurrenceInBlock }
				: undefined;

			await this.plugin.openSession(session, turnIndex, highlight);
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

/**
 * Given precise turn-based matches and the streaming result's
 * (turnIndex, contextBefore), pick the best coordinate target. Prefers
 * matches in the same turn; when multiple, disambiguates by contextBefore
 * suffix (Phase 2 Gotcha C). Returns undefined when no matches exist.
 */
function pickBestMatch(
	matches: InSessionMatch[],
	preferredTurnIndex: number,
	contextBefore: string,
): InSessionMatch | undefined {
	if (matches.length === 0) return undefined;

	const sameTurn = matches.filter(m => m.turnIndex === preferredTurnIndex);
	if (sameTurn.length === 0) return matches[0];
	if (sameTurn.length === 1) return sameTurn[0];

	// Disambiguate multi-hit turns by the trailing characters of contextBefore.
	const suffix = contextBefore.slice(-20).toLowerCase();
	if (suffix) {
		const byContext = sameTurn.find(m => m.contextBefore.toLowerCase().endsWith(suffix));
		if (byContext) return byContext;
	}
	return sameTurn[0];
}
