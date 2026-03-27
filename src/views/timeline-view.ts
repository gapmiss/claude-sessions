import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import { Session, PluginSettings } from '../types';
import { TimelineRenderer } from './timeline-renderer';
import { readFileContent } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';
import { resolveSubAgentSessions } from '../parsers/claude-subagent';

export const VIEW_TYPE_TIMELINE = 'claude-sessions-timeline';

interface TimelineViewState {
	sessionPath?: string;
	turnIndex?: number;
}

interface FilterState {
	// Top-level section toggles (parent controls)
	user: boolean;
	assistant: boolean;
	// User children
	userText: boolean;
	userImages: boolean;
	// Assistant children
	assistantText: boolean;
	thinking: boolean;
	toolCalls: boolean;
	toolResults: boolean;
}

export class TimelineView extends ItemView {
	private session: Session | null = null;
	private renderer: TimelineRenderer | null = null;
	private settings: PluginSettings;
	private controlsEl: HTMLElement | null = null;
	private timelineEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private progressBar: HTMLElement | null = null;
	private progressTooltip: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	private activeTurnIndex = 0;

	// Timing data
	private sessionStartMs = 0;
	private sessionTotalMs = 0;
	private turnStartMs: number[] = [];
	private turnEndMs: number[] = [];
	private displayedTimeMs = 0;

	// File watcher
	private watcher: import('fs').FSWatcher | null = null;
	private debounceTimer: number | null = null;
	private isWatching = false;
	private isFollowing = true;
	private watchBtn: HTMLButtonElement | null = null;

	// Search highlight
	private activeHighlight: HTMLElement | null = null;
	private highlightTimer: number | null = null;

	// Content filters
	private filters: FilterState = {
		user: true,
		assistant: true,
		userText: true,
		userImages: true,
		assistantText: true,
		thinking: true,
		toolCalls: true,
		toolResults: true,
	};

	constructor(leaf: WorkspaceLeaf, settings: PluginSettings) {
		super(leaf);
		this.settings = settings;
	}

	getViewType(): string {
		return VIEW_TYPE_TIMELINE;
	}

	getDisplayText(): string {
		if (this.session) {
			return `Session: ${this.session.metadata.project}`;
		}
		return 'Claude session';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('claude-sessions-timeline-container');

		// Timeline area (scrollable)
		this.timelineEl = contentEl.createDiv({ cls: 'claude-sessions-timeline markdown-rendered' });
		this.renderer = new TimelineRenderer(this.timelineEl, this.app, this, this.settings);

		// Controls bar (fixed at bottom)
		this.controlsEl = contentEl.createDiv({ cls: 'claude-sessions-controls' });
		this.buildControls(this.controlsEl);

		if (!this.session) {
			this.timelineEl.createDiv({
				cls: 'claude-sessions-empty',
				text: 'No session loaded. Use "Browse sessions" or "Import session file" to load one.',
			});
		}
	}

	async onClose(): Promise<void> {
		this.clearHighlight();
		this.stopWatching();
		this.destroyObserver();
	}

	getState(): Record<string, unknown> {
		return {
			sessionPath: this.session?.rawPath,
			turnIndex: this.activeTurnIndex,
		};
	}

	async setState(state: TimelineViewState): Promise<void> {
		if (state.sessionPath && !this.session) {
			try {
				const content = await readFileContent(state.sessionPath);
				const parser = detectParser(content);
				if (parser) {
					const session = parser.parse(content, state.sessionPath);
					await resolveSubAgentSessions(session, readFileContent);
					this.loadSession(session);
				}
			} catch {
				// File may have been moved/deleted since last workspace save
			}
		}
		if (state.turnIndex !== undefined && this.session) {
			this.scrollToTurn(state.turnIndex);
		}
	}

	loadSession(session: Session, opts?: { scrollToEnd?: boolean }): void {
		const savedIndex = this.activeTurnIndex;
		this.session = session;

		if (opts?.scrollToEnd && session.turns.length > 0) {
			this.activeTurnIndex = session.turns.length - 1;
		} else {
			this.activeTurnIndex = Math.min(savedIndex, session.turns.length - 1);
		}

		if (this.renderer) {
			this.renderer.updateSettings(this.settings);
		}

		this.computeTiming();

		(this.leaf as unknown as { updateHeader?(): void }).updateHeader?.();

		this.renderFullTimeline();
		this.renderTurnDots();
		this.syncTimer();
		this.updateControls();

		if (opts?.scrollToEnd && this.timelineEl) {
			requestAnimationFrame(() => {
				if (this.timelineEl) {
					this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
				}
			});
		}
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		if (this.renderer) {
			this.renderer.updateSettings(settings);
			if (this.session) {
				const savedIndex = this.activeTurnIndex;
				this.renderFullTimeline();
				this.renderTurnDots();
				this.scrollToTurn(savedIndex);
				this.updateControls();
			}
		}
	}

	getSession(): Session | null {
		return this.session;
	}

	getTimelineEl(): HTMLElement | null {
		return this.timelineEl;
	}

	async reloadSession(): Promise<void> {
		const filePath = this.session?.rawPath;
		if (!filePath) {
			new Notice('No session file path to reload from.');
			return;
		}
		try {
			const content = await readFileContent(filePath);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format on reload.');
				return;
			}
			const session = parser.parse(content, filePath);
			await resolveSubAgentSessions(session, readFileContent);
			this.loadSession(session, { scrollToEnd: this.settings.autoScrollOnUpdate });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to reload session: ${msg}`);
			this.stopWatching();
		}
	}

	toggleWatch(): void {
		if (this.isWatching) {
			this.stopWatching();
		} else {
			this.startWatching();
		}
	}

	stopWatching(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.isWatching = false;
		this.updateWatchIndicator();
	}

	private startWatching(): void {
		const filePath = this.session?.rawPath;
		if (!filePath) {
			new Notice('No session file path to watch.');
			return;
		}

		const fs = require('fs') as typeof import('fs');

		const onChange = () => {
			if (this.debounceTimer !== null) {
				window.clearTimeout(this.debounceTimer);
			}
			this.debounceTimer = window.setTimeout(() => {
				this.debounceTimer = null;
				this.reloadSession();
			}, 1500);
		};

		try {
			this.watcher = fs.watch(filePath, { persistent: false }, (eventType: string) => {
				if (eventType === 'change') onChange();
			});
			this.watcher.on('error', () => {
				new Notice('Session file watcher error — stopping.');
				this.stopWatching();
			});
		} catch {
			// fs.watch unavailable — fall back to polling
			try {
				fs.watchFile(filePath, { interval: 2000, persistent: false }, (curr, prev) => {
					if (curr.mtimeMs !== prev.mtimeMs) onChange();
				});
				this.watcher = {
					close: () => fs.unwatchFile(filePath),
					on: () => this,
				} as unknown as import('fs').FSWatcher;
			} catch {
				new Notice('Could not watch session file.');
				return;
			}
		}

		this.isWatching = true;
		this.updateWatchIndicator();

		// Immediately reload to catch any changes since the session was first opened
		this.reloadSession();
	}

	private updateWatchIndicator(): void {
		if (!this.watchBtn) return;
		if (this.isWatching) {
			this.watchBtn.addClass('claude-sessions-watch-active');
			this.watchBtn.setAttribute('aria-label', 'Stop live watch');
		} else {
			this.watchBtn.removeClass('claude-sessions-watch-active');
			this.watchBtn.setAttribute('aria-label', 'Start live watch');
		}
	}

	getSessionStartMs(): number {
		return this.sessionStartMs;
	}

	// Navigation — scroll to a specific turn
	scrollToTurn(index: number): void {
		if (!this.session) return;
		const target = Math.max(0, Math.min(index, this.session.turns.length - 1));
		const turnEls = this.renderer?.getTurnElements() || [];
		const el = turnEls[target];
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
		this.activeTurnIndex = target;
		this.syncTimer();
		this.updateControls();
	}

	nextTurn(): void {
		if (!this.session) return;
		if (this.activeTurnIndex < this.session.turns.length - 1) {
			this.scrollToTurn(this.activeTurnIndex + 1);
		}
	}

	prevTurn(): void {
		if (!this.session) return;
		if (this.activeTurnIndex > 0) {
			this.scrollToTurn(this.activeTurnIndex - 1);
		}
	}

	// ── In-session search ──

	openInSessionSearch(): void {
		if (!this.session?.rawPath) return;
		// Use string constant to avoid circular import with search-view.ts
		const SEARCH_TYPE = 'claude-sessions-search';
		const existing = this.app.workspace.getLeavesOfType(SEARCH_TYPE);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			leaf = right;
			leaf.setViewState({ type: SEARCH_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view && 'setMode' in view) {
			(view as { setMode(mode: string): void }).setMode('in-session');
		}
	}

	navigateToMatch(turnIndex: number, query: string): void {
		this.clearHighlight();
		this.scrollToTurn(turnIndex);
		// Allow scroll to settle before highlighting
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				this.highlightMatchInTurn(turnIndex, query);
			});
		});
	}

	private highlightMatchInTurn(turnIndex: number, query: string): void {
		const turnEls = this.renderer?.getTurnElements() || [];
		const turnEl = turnEls[turnIndex];
		if (!turnEl) return;

		// Expand the turn if collapsed
		if (turnEl.hasClass('collapsed')) {
			turnEl.removeClass('collapsed');
			const header = turnEl.querySelector('.claude-sessions-turn-header');
			if (header) header.setAttribute('aria-expanded', 'true');
		}

		const lowerQuery = query.toLowerCase();
		const walker = document.createTreeWalker(turnEl, NodeFilter.SHOW_TEXT);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent || '';
			const idx = text.toLowerCase().indexOf(lowerQuery);
			if (idx === -1) continue;

			// Expand any collapsed ancestors between the text node and turn
			this.expandAncestors(node, turnEl);

			// Split text node and wrap match in <mark>
			const before = node.splitText(idx);
			const after = before.splitText(query.length);
			// after is unused but splitText needs the call to isolate the match
			void after;

			const mark = document.createElement('mark');
			mark.className = 'claude-sessions-search-highlight';
			before.parentNode!.replaceChild(mark, before);
			mark.appendChild(document.createTextNode(before.textContent || ''));

			this.activeHighlight = mark;
			mark.scrollIntoView({ behavior: 'smooth', block: 'center' });

			// Auto-clear after 3s
			this.highlightTimer = window.setTimeout(() => this.clearHighlight(), 5000);
			return;
		}
	}

	private expandAncestors(node: Node, boundary: HTMLElement): void {
		let el = node.parentElement;
		while (el && el !== boundary) {
			// Tool block
			if (el.hasClass('claude-sessions-tool-block') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-tool-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			// Tool group
			if (el.hasClass('claude-sessions-tool-group') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-tool-group-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			// Thinking block
			if (el.hasClass('claude-sessions-thinking-block') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-thinking-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			// Show-more collapse
			if (el.hasClass('claude-sessions-collapsible-wrap') && el.hasClass('is-collapsed')) {
				el.removeClass('is-collapsed');
				const btn = el.querySelector('.claude-sessions-show-more-btn');
				if (btn) btn.setAttribute('aria-expanded', 'true');
			}
			// Sub-agent prompt
			if (el.hasClass('claude-sessions-subagent-prompt') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-subagent-prompt-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			el = el.parentElement;
		}
	}

	private clearHighlight(): void {
		if (this.activeHighlight) {
			const text = this.activeHighlight.textContent || '';
			const textNode = document.createTextNode(text);
			this.activeHighlight.parentNode?.replaceChild(textNode, this.activeHighlight);
			textNode.parentNode?.normalize();
			this.activeHighlight = null;
		}
		if (this.highlightTimer !== null) {
			window.clearTimeout(this.highlightTimer);
			this.highlightTimer = null;
		}
	}

	// Timing computation
	private computeTiming(): void {
		this.turnStartMs = [];
		this.turnEndMs = [];
		this.sessionStartMs = 0;
		this.sessionTotalMs = 0;
		this.displayedTimeMs = 0;

		if (!this.session || this.session.turns.length === 0) return;

		const startStr = this.session.metadata.startTime
			|| this.session.turns[0].timestamp;
		if (!startStr) return;

		const startMs = new Date(startStr).getTime();
		if (isNaN(startMs)) return;

		this.sessionStartMs = startMs;

		let hasAnyTimestamp = false;
		for (let i = 0; i < this.session.turns.length; i++) {
			const turn = this.session.turns[i];
			const tsMs = turn.timestamp ? new Date(turn.timestamp).getTime() : NaN;
			const endMs = turn.endTimestamp ? new Date(turn.endTimestamp).getTime() : tsMs;

			if (!isNaN(tsMs)) {
				this.turnStartMs[i] = tsMs - this.sessionStartMs;
				this.turnEndMs[i] = (!isNaN(endMs) ? endMs : tsMs) - this.sessionStartMs;
				hasAnyTimestamp = true;
			} else {
				this.turnStartMs[i] = 0;
				this.turnEndMs[i] = 0;
			}
		}

		if (!hasAnyTimestamp) {
			this.turnStartMs = [];
			this.turnEndMs = [];
			this.sessionStartMs = 0;
			return;
		}

		const last = this.session.turns.length - 1;
		this.sessionTotalMs = this.turnEndMs[last] || this.turnStartMs[last] || 0;
	}

	private syncTimer(): void {
		if (this.turnStartMs.length > this.activeTurnIndex) {
			// Use turn end time for the last turn so the progress bar reaches 100%
			const isLast = this.session && this.activeTurnIndex === this.session.turns.length - 1;
			this.displayedTimeMs = isLast
				? (this.turnEndMs[this.activeTurnIndex] || this.turnStartMs[this.activeTurnIndex] || 0)
				: (this.turnStartMs[this.activeTurnIndex] || 0);
		}
	}

	/** Map a progress bar percentage to a turn index (equally spaced). */
	private turnFromPct(pct: number): number {
		if (!this.session || this.session.turns.length === 0) return 0;
		return Math.min(Math.floor(pct * this.session.turns.length), this.session.turns.length - 1);
	}

	private formatTime(ms: number): string {
		if (ms <= 0) return '0:00';
		const totalSec = Math.round(ms / 1000);
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		const s = totalSec % 60;
		if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	/** Capture full UI state: collapse, expanded tools/text, scroll position. */
	private captureUIState(): {
		collapsedTurns: Set<number>;
		summaryOpen: boolean;
		openTools: Set<string>;
		expandedText: Set<string>;
		scrollTop: number;
	} {
		const collapsedTurns = new Set<number>();
		const turnEls = this.renderer?.getTurnElements() || [];
		for (let i = 0; i < turnEls.length; i++) {
			if (turnEls[i].hasClass('collapsed')) {
				collapsedTurns.add(i);
			}
		}
		const summaryEl = this.timelineEl?.querySelector('.claude-sessions-summary');
		const summaryOpen = summaryEl?.hasClass('open') ?? false;

		// Expanded tool blocks: keyed by "turnIndex-blockIndex"
		const openTools = new Set<string>();
		for (let t = 0; t < turnEls.length; t++) {
			const toolBlocks = turnEls[t].querySelectorAll('.claude-sessions-tool-block');
			for (let b = 0; b < toolBlocks.length; b++) {
				if (toolBlocks[b].hasClass('open')) {
					openTools.add(`${t}-${b}`);
				}
			}
		}

		// Expanded "show more" blocks: keyed by "turnIndex-wrapIndex"
		const expandedText = new Set<string>();
		for (let t = 0; t < turnEls.length; t++) {
			const wraps = turnEls[t].querySelectorAll('.claude-sessions-collapsible-wrap');
			for (let w = 0; w < wraps.length; w++) {
				if (!wraps[w].hasClass('is-collapsed')) {
					expandedText.add(`${t}-${w}`);
				}
			}
		}

		const scrollTop = this.timelineEl?.scrollTop ?? 0;

		return { collapsedTurns, summaryOpen, openTools, expandedText, scrollTop };
	}

	/** Restore full UI state after re-render. */
	private restoreUIState(state: ReturnType<typeof TimelineView.prototype.captureUIState>): void {
		const turnEls = this.renderer?.getTurnElements() || [];
		for (const idx of state.collapsedTurns) {
			if (idx < turnEls.length) {
				turnEls[idx].addClass('collapsed');
				const chevron = turnEls[idx].querySelector('.claude-sessions-turn-chevron');
				if (chevron) chevron.textContent = '\u25B6';
				const header = turnEls[idx].querySelector('.claude-sessions-turn-header');
				header?.setAttribute('aria-expanded', 'false');
			}
		}
		if (state.summaryOpen) {
			const summaryEl = this.timelineEl?.querySelector('.claude-sessions-summary');
			summaryEl?.addClass('open');
			const chevron = summaryEl?.querySelector('.claude-sessions-summary-chevron');
			if (chevron) chevron.textContent = '\u25BC';
			const header = summaryEl?.querySelector('.claude-sessions-summary-header');
			header?.setAttribute('aria-expanded', 'true');
		}

		// Restore expanded tool blocks
		for (const key of state.openTools) {
			const [t, b] = key.split('-').map(Number);
			if (t < turnEls.length) {
				const toolBlocks = turnEls[t].querySelectorAll('.claude-sessions-tool-block');
				if (b < toolBlocks.length) {
					toolBlocks[b].addClass('open');
					const header = toolBlocks[b].querySelector('.claude-sessions-tool-header');
					header?.setAttribute('aria-expanded', 'true');
				}
			}
		}

		// Restore expanded "show more" blocks
		for (const key of state.expandedText) {
			const [t, w] = key.split('-').map(Number);
			if (t < turnEls.length) {
				const wraps = turnEls[t].querySelectorAll('.claude-sessions-collapsible-wrap');
				if (w < wraps.length) {
					wraps[w].removeClass('is-collapsed');
					const btn = wraps[w].querySelector('.claude-sessions-collapsible-toggle');
					if (btn) {
						btn.textContent = 'Show less';
						(btn as HTMLElement).setAttribute('aria-expanded', 'true');
					}
				}
			}
		}

		// Restore scroll position
		if (this.timelineEl) {
			this.timelineEl.scrollTop = state.scrollTop;
		}
	}

	// Rendering
	private renderFullTimeline(): void {
		if (!this.session || !this.renderer || !this.timelineEl) return;

		// Capture full UI state before destroying the DOM
		const uiState = this.captureUIState();
		this.destroyObserver();

		if (this.session.turns.length === 0) {
			this.timelineEl.empty();
			this.timelineEl.createDiv({
				cls: 'claude-sessions-empty',
				text: 'This session has no turns.',
			});
			return;
		}

		this.renderer.renderTimeline(this.session.turns, this.sessionStartMs, this.session);
		this.restoreUIState(uiState);
		this.setupScrollObserver();
	}

	private setupScrollObserver(): void {
		if (!this.timelineEl) return;

		const turnEls = this.renderer?.getTurnElements() || [];
		if (turnEls.length === 0) return;

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					if (entry.isIntersecting) {
						el.addClass('visible');
					} else {
						el.removeClass('visible');
					}
				}

				const scrollEl = this.timelineEl;
				const atBottom = scrollEl
					? scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 50
					: false;
				this.isFollowing = atBottom;

				// Use the bottommost visible turn as the active turn
				let active = -1;
				if (atBottom) {
					active = turnEls.length - 1;
				} else {
					for (let i = turnEls.length - 1; i >= 0; i--) {
						if (turnEls[i].hasClass('visible')) { active = i; break; }
					}
				}
				if (active >= 0) {
					this.activeTurnIndex = active;
					this.syncTimer();
					this.updateControls();
				}
			},
			{
				root: this.timelineEl,
				rootMargin: '0px',
				threshold: 0.1,
			}
		);

		for (const el of turnEls) {
			this.observer.observe(el);
		}
	}

	private destroyObserver(): void {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
	}

	// Turn separator dots on progress bar — placed at boundaries between turns
	private renderTurnDots(): void {
		if (!this.session || !this.progressBar) return;

		const total = this.session.turns.length;
		const existingDots = this.progressBar.querySelectorAll('.claude-sessions-turn-dot');

		if (total <= 1) {
			existingDots.forEach(d => d.remove());
			return;
		}

		const needed = total - 1;

		// Reposition existing dots and add new ones as needed
		for (let i = 0; i < needed; i++) {
			const dot = i < existingDots.length
				? existingDots[i] as HTMLElement
				: this.progressBar.createDiv({ cls: 'claude-sessions-turn-dot' });
			const pct = ((i + 1) / total) * 100;
			dot.style.left = `${pct}%`;
			dot.dataset.turnIndex = String(i + 1);
		}

		// Remove excess dots if turn count shrank
		for (let i = needed; i < existingDots.length; i++) {
			existingDots[i].remove();
		}
	}

	private updateTurnDots(): void {
		if (!this.progressBar) return;
		const dots = this.progressBar.querySelectorAll('.claude-sessions-turn-dot');
		dots.forEach((dot) => {
			const idx = parseInt((dot as HTMLElement).dataset.turnIndex || '0', 10);
			dot.toggleClass('reached', idx <= this.activeTurnIndex);
		});
	}

	// Controls
	private buildControls(container: HTMLElement): void {
		const row = container.createDiv({ cls: 'claude-sessions-controls-row' });

		// Status text
		this.statusEl = row.createSpan({ cls: 'claude-sessions-progress-text' });

		// Search button
		const searchBtn = row.createEl('button', {
			cls: 'claude-sessions-ctrl-btn claude-sessions-search-btn',
			attr: { 'aria-label': 'Search in session', 'data-tooltip-position': 'top' },
		});
		setIcon(searchBtn, 'search');
		searchBtn.addEventListener('click', () => this.openInSessionSearch());

		// Filter button
		const filterBtn = row.createEl('button', {
			cls: 'claude-sessions-ctrl-btn claude-sessions-filter-btn',
			attr: { 'aria-label': 'Filter content', 'data-tooltip-position': 'top' },
			text: '\u22EF',
		});
		filterBtn.addEventListener('click', (e: MouseEvent) => {
			this.showFilterMenu(e);
		});
		filterBtn.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.showFilterMenu(e);
			}
		});

		// Watch button
		this.watchBtn = row.createEl('button', {
			cls: 'claude-sessions-ctrl-btn claude-sessions-watch-btn',
			attr: { 'aria-label': 'Start live watch', 'data-tooltip-position': 'top' },
		});
		setIcon(this.watchBtn, 'radio');
		this.watchBtn.addEventListener('click', () => this.toggleWatch());

		// Progress bar (read-only indicator, not keyboard-interactive)
		const progressWrap = container.createDiv({ cls: 'claude-sessions-progress-wrap' });
		this.progressBar = progressWrap.createDiv({ cls: 'claude-sessions-progress-bar' });
		this.progressBar.setAttribute('role', 'progressbar');
		this.progressBar.setAttribute('aria-label', 'Session progress');
		this.progressBar.setAttribute('aria-valuemin', '0');
		this.progressBar.setAttribute('aria-valuemax', '0');
		this.progressBar.setAttribute('aria-valuenow', '0');
		this.progressBar.setAttribute('aria-valuetext', 'No session loaded');
		this.progressFill = this.progressBar.createDiv({ cls: 'claude-sessions-progress-fill' });
		this.progressTooltip = this.progressBar.createDiv({ cls: 'claude-sessions-progress-tooltip' });

		// Hover tooltip on progress bar
		this.progressBar.addEventListener('mousemove', (e: MouseEvent) => {
			if (!this.session || !this.progressTooltip) return;
			const rect = this.progressBar!.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

			const turnIdx = this.turnFromPct(pct);
			let label = `#${turnIdx + 1}`;
			if (this.turnStartMs[turnIdx] !== undefined && this.sessionTotalMs > 0) {
				label += ` \u00B7 ${this.formatTime(this.turnStartMs[turnIdx])}`;
			}
			this.progressTooltip.setText(label);
			const left = Math.max(20, Math.min(rect.width - 20, e.clientX - rect.left));
			this.progressTooltip.style.left = `${left}px`;
		});

		// Click on progress bar to seek
		this.progressBar.addEventListener('click', (e: MouseEvent) => {
			if (!this.session) return;
			const rect = this.progressBar!.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			this.scrollToTurn(this.turnFromPct(pct));
		});

		// Keyboard shortcuts
		this.registerDomEvent(container.doc, 'keydown', (e: KeyboardEvent) => {
			if (!this.session) return;
			const activeView = this.app.workspace.getActiveViewOfType(TimelineView);
			if (activeView !== this) return;

			// Skip if focus is inside an input, textarea, or contentEditable element
			const target = e.target as HTMLElement;
			if (target.tagName === 'INPUT'
				|| target.tagName === 'TEXTAREA'
				|| target.isContentEditable) {
				return;
			}

			switch (e.key) {
				case 'ArrowLeft':
					e.preventDefault();
					this.prevTurn();
					break;
				case 'ArrowRight':
					e.preventDefault();
					this.nextTurn();
					break;
			}
		});

	}

	private showFilterMenu(e: MouseEvent | KeyboardEvent): void {
		const menu = new Menu();
		const f = this.filters;

		// ── User section ──
		menu.addItem(item => item
			.setTitle('User')
			.setIcon('user')
			.setIsLabel(true));

		menu.addItem(item => item
			.setTitle('Text')
			.setChecked(f.user && f.userText)
			.setDisabled(!f.user)
			.onClick(() => { f.userText = !f.userText; this.applyFilters(); }));

		menu.addItem(item => item
			.setTitle('Images')
			.setChecked(f.user && f.userImages)
			.setDisabled(!f.user)
			.onClick(() => { f.userImages = !f.userImages; this.applyFilters(); }));

		menu.addItem(item => item
			.setTitle(f.user ? 'Hide all' : 'Show all')
			.setIcon(f.user ? 'eye-off' : 'eye')
			.onClick(() => { f.user = !f.user; this.applyFilters(); }));

		menu.addSeparator();

		// ── Assistant section ──
		menu.addItem(item => item
			.setTitle('Assistant')
			.setIcon('message-square')
			.setIsLabel(true));

		menu.addItem(item => item
			.setTitle('Text')
			.setChecked(f.assistant && f.assistantText)
			.setDisabled(!f.assistant)
			.onClick(() => { f.assistantText = !f.assistantText; this.applyFilters(); }));

		menu.addItem(item => item
			.setTitle('Thinking')
			.setIcon('brain')
			.setChecked(f.assistant && f.thinking)
			.setDisabled(!f.assistant)
			.onClick(() => { f.thinking = !f.thinking; this.applyFilters(); }));

		menu.addItem(item => item
			.setTitle('Tool calls')
			.setIcon('wrench')
			.setChecked(f.assistant && f.toolCalls)
			.setDisabled(!f.assistant)
			.onClick(() => { f.toolCalls = !f.toolCalls; this.applyFilters(); }));

		menu.addItem(item => item
			.setTitle('Tool results')
			.setIcon('file-output')
			.setChecked(f.assistant && f.toolResults)
			.setDisabled(!f.assistant)
			.onClick(() => { f.toolResults = !f.toolResults; this.applyFilters(); }));

		menu.addItem(item => item
			.setTitle(f.assistant ? 'Hide all' : 'Show all')
			.setIcon(f.assistant ? 'eye-off' : 'eye')
			.onClick(() => { f.assistant = !f.assistant; this.applyFilters(); }));

		if (e instanceof MouseEvent && (e.clientX !== 0 || e.clientY !== 0)) {
			menu.showAtMouseEvent(e);
		} else {
			const rect = (e.target as HTMLElement).getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.top });
		}
	}

	private applyFilters(): void {
		if (!this.timelineEl) return;
		const f = this.filters;

		// ── User section (parent toggle) ──
		this.timelineEl.querySelectorAll('.claude-sessions-role-user').forEach(el => {
			(el as HTMLElement).toggleClass('claude-sessions-filtered', !f.user);
		});

		// User children (only matter when parent is on)
		if (f.user) {
			this.timelineEl.querySelectorAll('.claude-sessions-user-text').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.claude-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('claude-sessions-filtered', !f.userText);
			});
			this.timelineEl.querySelectorAll('.claude-sessions-slash-command-block').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.claude-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('claude-sessions-filtered', !f.userText);
			});
			this.timelineEl.querySelectorAll('.claude-sessions-image-thumbnail').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.claude-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('claude-sessions-filtered', !f.userImages);
			});
		}

		// ── Assistant section (parent toggle) ──
		this.timelineEl.querySelectorAll('.claude-sessions-role-assistant').forEach(el => {
			(el as HTMLElement).toggleClass('claude-sessions-filtered', !f.assistant);
		});

		// Assistant children (only matter when parent is on)
		if (f.assistant) {
			this.timelineEl.querySelectorAll('.claude-sessions-assistant-text').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.claude-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('claude-sessions-filtered', !f.assistantText);
			});
			this.timelineEl.querySelectorAll('.claude-sessions-thinking-block').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.claude-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('claude-sessions-filtered', !f.thinking);
			});
			this.timelineEl.querySelectorAll('.claude-sessions-tool-block, .claude-sessions-tool-group').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.claude-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('claude-sessions-filtered', !f.toolCalls);
			});
			this.timelineEl.querySelectorAll('.claude-sessions-tool-result').forEach(el => {
				(el as HTMLElement).toggleClass('claude-sessions-filtered', !f.toolResults);
			});
		}

		// Update filter button appearance
		const allOn = f.user && f.assistant && f.userText && f.userImages
			&& f.assistantText && f.thinking && f.toolCalls && f.toolResults;
		this.controlsEl?.querySelector('.claude-sessions-filter-btn')
			?.toggleClass('claude-sessions-filter-active', !allOn);
	}

	private updateControls(): void {
		if (!this.session) return;
		const total = this.session.turns.length;

		if (this.statusEl) {
			if (this.sessionTotalMs > 0) {
				this.statusEl.setText(
					`#${this.activeTurnIndex + 1}/${total} \u00B7 ${this.formatTime(this.displayedTimeMs)} / ${this.formatTime(this.sessionTotalMs)}`
				);
			} else {
				this.statusEl.setText(`#${this.activeTurnIndex + 1} / ${total}`);
			}
		}

		if (this.progressFill && total > 0) {
			const pct = ((this.activeTurnIndex + 1) / total) * 100;
			this.progressFill.style.width = `${pct}%`;
		}

		// Update ARIA progressbar values
		if (this.progressBar) {
			this.progressBar.setAttribute('aria-valuemax', String(total));
			this.progressBar.setAttribute('aria-valuenow', String(this.activeTurnIndex + 1));
			if (this.sessionTotalMs > 0) {
				this.progressBar.setAttribute('aria-valuetext',
					`Turn ${this.activeTurnIndex + 1} of ${total} · ${this.formatTime(this.displayedTimeMs)} / ${this.formatTime(this.sessionTotalMs)}`);
			} else {
				this.progressBar.setAttribute('aria-valuetext',
					`Turn ${this.activeTurnIndex + 1} of ${total}`);
			}
		}

		this.updateTurnDots();
	}
}
