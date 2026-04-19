import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import * as fs from 'fs';
import { makeClickable } from './render-helpers';
import { Session, PluginSettings } from '../types';
import { TimelineRenderer } from './timeline-renderer';
import { readFileContent, listDirectoryFiles } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';
import { resolveSubAgentSessions } from '../parsers/claude-subagent';
import { BT_TOOL_USE, SUBAGENT_TOOL_NAMES } from '../constants';

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
	private activeHighlights: HTMLElement[] = [];
	private highlightTimer: number | null = null;

	// Pending tool notification dedup
	private lastNotifiedToolId: string | null = null;

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
		const meta = this.session?.metadata;
		return meta?.customTitle || meta?.project || 'Claude sessions';
	}

	getIcon(): string {
		return 'claude-sparkle';
	}

	onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('claude-sessions-timeline-container');

		// Timeline area (scrollable)
		this.timelineEl = contentEl.createDiv({ cls: 'claude-sessions-timeline markdown-rendered' });
		this.renderer = new TimelineRenderer(this.timelineEl, this.app, this, this.settings);
		this.applyMaxWidth();

		// Controls bar (fixed at bottom)
		this.controlsEl = contentEl.createDiv({ cls: 'claude-sessions-controls' });
		this.buildControls(this.controlsEl);

		if (!this.session) {
			this.timelineEl.createDiv({
				cls: 'claude-sessions-empty',
				text: 'No session loaded. Use "Browse sessions" or "Import session file" to load one.',
			});
		}
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.clearHighlight();
		this.stopWatching();
		this.destroyObserver();
		this.renderer?.destroyMermaidObserver();
		return Promise.resolve();
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
					await resolveSubAgentSessions(session, readFileContent, listDirectoryFiles);
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
		const titleEl = this.containerEl.parentElement?.querySelector<HTMLElement>('.view-header-title');
		if (titleEl) titleEl.textContent = this.getDisplayText();

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
		this.applyMaxWidth();
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

	/** Update the --max-content-width CSS variable without re-rendering. */
	applyMaxWidth(): void {
		const w = this.settings.maxContentWidth;
		this.contentEl.style.setProperty('--max-content-width', w > 0 ? `${w}px` : 'none');
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
			await resolveSubAgentSessions(session, readFileContent, listDirectoryFiles);

			const prevCount = this.session?.turns.length ?? 0;
			const newCount = session.turns.length;

			// Collect pending background agent block IDs before re-parse
			// so we can detect which ones completed during this reload.
			const pendingBgAgents = new Set<string>();
			if (this.session) {
				for (const turn of this.session.turns) {
					for (const block of turn.contentBlocks) {
						if (block.type === BT_TOOL_USE
							&& SUBAGENT_TOOL_NAMES.has(block.name)
							&& block.subAgentSession?.isBackground
							&& !block.subAgentSession.durationMs) {
							pendingBgAgents.add(block.id);
						}
					}
				}
			}

			// Incremental DOM path: if the session only grew (append-only),
			// update just what changed instead of tearing down the whole DOM.
			if (this.renderer && this.observer && prevCount > 0 && newCount >= prevCount) {
				// Update hook events map for inline indicators during live watch
				this.renderer.updateHookEvents(session);

				// Refresh turns containing background agents that just completed
				if (pendingBgAgents.size > 0) {
					for (let ti = 0; ti < prevCount - 1; ti++) {
						const turn = session.turns[ti];
						const hasCompleted = turn.contentBlocks.some(b =>
							b.type === BT_TOOL_USE
							&& pendingBgAgents.has(b.id)
							&& b.subAgentSession?.durationMs);
						if (hasCompleted) {
							const oldEl = this.renderer.getTurnElements()[ti];
							const state = oldEl ? this.captureTurnState(oldEl) : null;
							const newEl = this.renderer.refreshTurnAt(ti, turn);
							if (state && newEl) this.restoreTurnState(newEl, state);
							if (newEl) this.observer.observe(newEl);
						}
					}
				}

				// Refresh the last existing turn — capture its UI state first
				// so expand/collapse survives the DOM replacement.
				const lastTurnEl = this.renderer.getTurnElements()[prevCount - 1];
				const lastTurnState = lastTurnEl ? this.captureTurnState(lastTurnEl) : null;
				this.renderer.refreshLastTurn(session.turns[prevCount - 1]);
				if (lastTurnState) {
					const newEl = this.renderer.getTurnElements()[prevCount - 1];
					this.restoreTurnState(newEl, lastTurnState);
				}
				// Re-observe the replaced element (old DOM node auto-unobserved on removal)
				this.observer.observe(this.renderer.getTurnElements()[prevCount - 1]);

				// Append genuinely new turns
				if (newCount > prevCount) {
					const appended = this.renderer.appendTurns(session.turns.slice(prevCount));

					// Observe new elements for scroll tracking
					for (const el of appended) {
						this.observer.observe(el);
					}

					// Apply current filter state to new turns only
					for (const el of appended) {
						this.applyFilters(el);
					}
				}

				// Update session reference and stats
				const oldTitle = this.session?.metadata?.customTitle || this.session?.metadata?.project;
				this.session = session;
				this.computeTiming();
				if (newCount > prevCount) {
					this.activeTurnIndex = session.turns.length - 1;
				}
				this.renderer.refreshSummary(session);
				this.renderTurnDots();
				this.updateControls();

				// Update tab title if session was renamed
				const newTitle = session.metadata?.customTitle || session.metadata?.project;
				if (newTitle !== oldTitle) {
					(this.leaf as unknown as { updateHeader?(): void }).updateHeader?.();
					const titleEl = this.containerEl.parentElement?.querySelector<HTMLElement>('.view-header-title');
					if (titleEl) titleEl.textContent = this.getDisplayText();
				}

				// Auto-scroll to bottom (matches loadSession behavior)
				if (this.settings.autoScrollOnUpdate && this.timelineEl) {
					requestAnimationFrame(() => {
						if (this.timelineEl) {
							this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
						}
					});
				}

				this.checkPendingToolNotification(session);
				return;
			}

			// Fallback: full re-render (session shrank, first load, etc.)
			this.loadSession(session, { scrollToEnd: this.settings.autoScrollOnUpdate });
			this.checkPendingToolNotification(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to reload session: ${msg}`);
			this.stopWatching();
		}
	}

	private checkPendingToolNotification(session: Session): void {
		if (!this.isWatching || !this.settings.notifyOnPendingTool) return;

		const turns = session.turns;
		if (turns.length === 0) return;

		const lastTurn = turns[turns.length - 1];
		if (lastTurn.role !== 'assistant') {
			this.lastNotifiedToolId = null;
			return;
		}

		const pendingTool = lastTurn.contentBlocks.find(
			b => b.type === 'tool_use' && b.isPending,
		);
		if (!pendingTool || pendingTool.type !== 'tool_use') {
			this.lastNotifiedToolId = null;
			return;
		}

		if (pendingTool.id === this.lastNotifiedToolId) return;
		this.lastNotifiedToolId = pendingTool.id;

		const displayName = session.metadata.customTitle || session.metadata.project || 'Claude sessions';
		const toolName = pendingTool.name;
		const title = `✦ ${displayName}`;
		const body = `"${toolName}" is waiting for permission`;

		new Notice(`${title}: ${body}`, 8000);

		const icon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDEwMCAxMDAiPjxyZWN0IHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIiByeD0iMjAiIGZpbGw9IiNkYTc3NTYiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg1MCw1MCkiIGZpbGw9Im5vbmUiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iNyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48bGluZSB5MT0iLTEyIiB5Mj0iLTM4Ii8+PGxpbmUgeTE9Ii0xMiIgeTI9Ii0zOCIgdHJhbnNmb3JtPSJyb3RhdGUoNDUpIi8+PGxpbmUgeTE9Ii0xMiIgeTI9Ii0zOCIgdHJhbnNmb3JtPSJyb3RhdGUoOTApIi8+PGxpbmUgeTE9Ii0xMiIgeTI9Ii0zOCIgdHJhbnNmb3JtPSJyb3RhdGUoMTM1KSIvPjxsaW5lIHkxPSItMTIiIHkyPSItMzgiIHRyYW5zZm9ybT0icm90YXRlKDE4MCkiLz48bGluZSB5MT0iLTEyIiB5Mj0iLTM4IiB0cmFuc2Zvcm09InJvdGF0ZSgyMjUpIi8+PGxpbmUgeTE9Ii0xMiIgeTI9Ii0zOCIgdHJhbnNmb3JtPSJyb3RhdGUoMjcwKSIvPjxsaW5lIHkxPSItMTIiIHkyPSItMzgiIHRyYW5zZm9ybT0icm90YXRlKDMxNSkiLz48L2c+PC9zdmc+';
		const sendNotification = () => {
			const n = new Notification(title, {
				body,
				icon,
				tag: 'claude-sessions-pending',
				requireInteraction: true,
			});
			n.onclick = () => {
				window.focus();
				n.close();
			};
		};

		if ('Notification' in window && Notification.permission === 'granted') {
			sendNotification();
		} else if ('Notification' in window && Notification.permission !== 'denied') {
			void Notification.requestPermission().then(perm => {
				if (perm === 'granted') sendNotification();
			});
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

		const onChange = () => {
			if (this.debounceTimer !== null) {
				window.clearTimeout(this.debounceTimer);
			}
			this.debounceTimer = window.setTimeout(() => {
				this.debounceTimer = null;
				void this.reloadSession();
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
		void this.reloadSession();
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

expandAll(): void {
		if (!this.timelineEl) return;
		for (const el of Array.from(this.timelineEl.querySelectorAll<HTMLElement>('.claude-sessions-turn.collapsed'))) {
			el.removeClass('collapsed');
			const h = el.querySelector('.claude-sessions-turn-header');
			if (h) h.setAttribute('aria-expanded', 'true');
		}
	}

	collapseAll(): void {
		if (!this.timelineEl) return;
		for (const el of Array.from(this.timelineEl.querySelectorAll<HTMLElement>('.claude-sessions-turn:not(.collapsed)'))) {
			el.addClass('collapsed');
			const h = el.querySelector('.claude-sessions-turn-header');
			if (h) h.setAttribute('aria-expanded', 'false');
		}
	}

	/** Expand all collapsible blocks: tools, thinking, summary, sub-agents, slash commands, compaction */
	expandAllBlocks(): void {
		if (!this.timelineEl) return;
		const selectors = [
			{ block: '.claude-sessions-tool-block:not(.open)', header: '.claude-sessions-tool-header' },
			{ block: '.claude-sessions-tool-group:not(.open)', header: '.claude-sessions-tool-group-header' },
			{ block: '.claude-sessions-thinking-block:not(.open)', header: '.claude-sessions-thinking-header' },
			{ block: '.claude-sessions-subagent-prompt:not(.open)', header: '.claude-sessions-subagent-prompt-header' },
			{ block: '.claude-sessions-slash-command-block:not(.open)', header: '.claude-sessions-slash-command-header' },
			{ block: '.claude-sessions-compaction-block:not(.open)', header: '.claude-sessions-compaction-summary-header' },
			{ block: '.claude-sessions-summary:not(.open)', header: '.claude-sessions-summary-header' },
		];
		for (const { block, header } of selectors) {
			for (const el of Array.from(this.timelineEl.querySelectorAll<HTMLElement>(block))) {
				el.addClass('open');
				const h = el.querySelector(header);
				if (h) h.setAttribute('aria-expanded', 'true');
			}
		}
		// Expand collapsible text blocks (show more / show less)
		for (const wrap of Array.from(this.timelineEl.querySelectorAll<HTMLElement>('.claude-sessions-collapsible-wrap.is-collapsed'))) {
			wrap.removeClass('is-collapsed');
			const btn = wrap.querySelector<HTMLElement>('.claude-sessions-collapsible-toggle');
			if (btn) {
				btn.setText('Show less');
				btn.setAttribute('aria-expanded', 'true');
			}
		}
	}

	/** Collapse all collapsible blocks: tools, thinking, summary, sub-agents, slash commands, compaction, text */
	collapseAllBlocks(): void {
		if (!this.timelineEl) return;
		const selectors = [
			{ block: '.claude-sessions-tool-block.open', header: '.claude-sessions-tool-header' },
			{ block: '.claude-sessions-tool-group.open', header: '.claude-sessions-tool-group-header' },
			{ block: '.claude-sessions-thinking-block.open', header: '.claude-sessions-thinking-header' },
			{ block: '.claude-sessions-subagent-prompt.open', header: '.claude-sessions-subagent-prompt-header' },
			{ block: '.claude-sessions-slash-command-block.open', header: '.claude-sessions-slash-command-header' },
			{ block: '.claude-sessions-compaction-block.open', header: '.claude-sessions-compaction-summary-header' },
			{ block: '.claude-sessions-summary.open', header: '.claude-sessions-summary-header' },
		];
		for (const { block, header } of selectors) {
			for (const el of Array.from(this.timelineEl.querySelectorAll<HTMLElement>(block))) {
				el.removeClass('open');
				const h = el.querySelector(header);
				if (h) h.setAttribute('aria-expanded', 'false');
			}
		}
		// Collapse collapsible text blocks (show more / show less)
		for (const wrap of Array.from(this.timelineEl.querySelectorAll<HTMLElement>('.claude-sessions-collapsible-wrap:not(.is-collapsed)'))) {
			wrap.addClass('is-collapsed');
			const btn = wrap.querySelector<HTMLElement>('.claude-sessions-collapsible-toggle');
			if (btn) {
				const lineCount = btn.getAttribute('data-line-count') ?? '';
				btn.setText(lineCount ? `Show more (${lineCount} lines)` : 'Show more');
				btn.setAttribute('aria-expanded', 'false');
			}
		}
	}

	// ── In-session search ──

	async openInSessionSearch(): Promise<void> {
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
			await leaf.setViewState({ type: SEARCH_TYPE, active: true });
		}
		void this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view && 'setMode' in view) {
			(view as { setMode(mode: string): void }).setMode('in-session');
		}
	}

	navigateToMatch(turnIndex: number, contentBlockIndex: number, needle: string, occurrenceInBlock: number): void {
		this.clearHighlight();
		this.scrollToTurn(turnIndex);
		// Allow scroll to settle before highlighting
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				this.highlightMatchInBlock(turnIndex, contentBlockIndex, needle, occurrenceInBlock);
			});
		});
	}

	private highlightMatchInBlock(
		turnIndex: number,
		contentBlockIndex: number,
		needle: string,
		occurrenceInBlock: number,
	): void {
		const turnEls = this.renderer?.getTurnElements() || [];
		const turnEl = turnEls[turnIndex];
		if (!turnEl || !needle) return;

		// Expand the turn if collapsed
		if (turnEl.hasClass('collapsed')) {
			turnEl.removeClass('collapsed');
			const header = turnEl.querySelector('.claude-sessions-turn-header');
			if (header) header.setAttribute('aria-expanded', 'true');
		}

		// Locate the content-block element stamped by the renderer. Missing
		// element means this content block's render path isn't stamped yet
		// (e.g. Edit/Write diff, AskUserQuestion, Agent branches) — we've
		// already scrolled to the turn, which is the graceful fallback.
		const blockEl = turnEl.querySelector<HTMLElement>(
			`[data-content-block-idx="${contentBlockIndex}"]`,
		);
		if (!blockEl) return;

		// Expand any collapsed ancestors (tool blocks, groups) before text search
		this.expandAncestors(blockEl, turnEl);

		// Text-search the rendered DOM (not indexed offsets) because markdown
		// syntax like **bold** is in the indexed text but stripped from the DOM.
		// Pick the Nth occurrence, matching the search layer's occurrenceInBlock
		// rank — ordering matches indexed-space even when characters are dropped.
		const textNodes: Text[] = [];
		const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
		let n: Text | null;
		while ((n = walker.nextNode() as Text | null)) textNodes.push(n);

		const combined = textNodes.map(t => t.textContent || '').join('');
		const lowerCombined = combined.toLowerCase();
		const lowerNeedle = needle.toLowerCase();

		const occurrences: number[] = [];
		let from = 0;
		while (true) {
			const idx = lowerCombined.indexOf(lowerNeedle, from);
			if (idx === -1) break;
			occurrences.push(idx);
			from = idx + 1;
		}
		if (occurrences.length === 0) return;

		const targetIdx = Math.min(occurrenceInBlock, occurrences.length - 1);
		const matchStart = occurrences[targetIdx];
		const matchEnd = matchStart + needle.length;

		const marks: HTMLElement[] = [];
		let consumed = 0;

		for (const node of textNodes) {
			const text = node.textContent || '';
			const nodeStart = consumed;
			const nodeEnd = consumed + text.length;
			consumed = nodeEnd;

			if (nodeEnd <= matchStart) continue;
			if (nodeStart >= matchEnd) break;

			const localStart = Math.max(0, matchStart - nodeStart);
			const localEnd = Math.min(text.length, matchEnd - nodeStart);
			if (localEnd <= localStart) continue;

			// Isolate [localStart, localEnd) as its own text node, then wrap in <mark>
			const middle = localStart > 0 ? node.splitText(localStart) : node;
			middle.splitText(localEnd - localStart);

			const mark = createEl('mark', { cls: 'claude-sessions-search-highlight' });
			middle.parentNode?.replaceChild(mark, middle);
			mark.appendText(middle.textContent || '');
			marks.push(mark);
		}

		if (marks.length === 0) return;

		this.expandAncestors(marks[0], turnEl);
		this.activeHighlights = marks;
		marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });

		this.highlightTimer = window.setTimeout(() => this.clearHighlight(), 5000);
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
				const btn = el.querySelector('.claude-sessions-collapsible-toggle');
				if (btn) btn.setAttribute('aria-expanded', 'true');
			}
			// Sub-agent prompt
			if (el.hasClass('claude-sessions-subagent-prompt') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-subagent-prompt-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			// Slash command block
			if (el.hasClass('claude-sessions-slash-command-block') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-slash-command-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			// Compaction summary
			if (el.hasClass('claude-sessions-compaction-block') && !el.hasClass('open')) {
				el.addClass('open');
				const h = el.querySelector('.claude-sessions-compaction-summary-header');
				if (h) h.setAttribute('aria-expanded', 'true');
			}
			// Markdown preview toggle — if match is in the hidden code view, show it
			if (el.hasClass('claude-sessions-read-md-hidden')) {
				el.removeClass('claude-sessions-read-md-hidden');
				// Hide the sibling view and update toggle buttons
				const parent = el.parentElement;
				if (parent) {
					const sibling = el.hasClass('claude-sessions-read-md-code')
						? parent.querySelector('.claude-sessions-read-md-preview')
						: parent.querySelector('.claude-sessions-read-md-code');
					if (sibling) sibling.addClass('claude-sessions-read-md-hidden');
				}
			}
			el = el.parentElement;
		}
	}

	private clearHighlight(): void {
		for (const mark of this.activeHighlights) {
			const parent = mark.parentNode;
			if (!parent) continue;
			const text = mark.textContent || '';
			parent.replaceChild(document.createTextNode(text), mark);
			parent.normalize();
		}
		this.activeHighlights = [];
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
		heroesPinned: boolean;
		openTools: Set<string>;
		openToolGroups: Set<string>;
		openThinking: Set<string>;
		expandedText: Set<string>;
		previewToggles: Set<string>;
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
		const pinnedEl = this.timelineEl?.querySelector('.claude-sessions-pinned-heroes');
		const heroesPinned = pinnedEl?.hasClass('is-pinned') ?? false;

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

		// Expanded tool groups: keyed by "turnIndex-groupIndex"
		const openToolGroups = new Set<string>();
		for (let t = 0; t < turnEls.length; t++) {
			const groups = turnEls[t].querySelectorAll('.claude-sessions-tool-group');
			for (let g = 0; g < groups.length; g++) {
				if (groups[g].hasClass('open')) {
					openToolGroups.add(`${t}-${g}`);
				}
			}
		}

		// Expanded thinking blocks: keyed by "turnIndex-thinkingIndex"
		const openThinking = new Set<string>();
		for (let t = 0; t < turnEls.length; t++) {
			const thinking = turnEls[t].querySelectorAll('.claude-sessions-thinking-block');
			for (let k = 0; k < thinking.length; k++) {
				if (thinking[k].hasClass('open')) {
					openThinking.add(`${t}-${k}`);
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

		// Markdown preview toggles in "preview" mode: keyed by "turnIndex-toggleIndex"
		const previewToggles = new Set<string>();
		for (let t = 0; t < turnEls.length; t++) {
			const toggles = turnEls[t].querySelectorAll('.claude-sessions-read-md-toggle');
			for (let m = 0; m < toggles.length; m++) {
				const codeView = toggles[m].querySelector('.claude-sessions-read-md-code');
				if (codeView?.hasClass('claude-sessions-read-md-hidden')) {
					previewToggles.add(`${t}-${m}`);
				}
			}
		}

		const scrollTop = this.timelineEl?.scrollTop ?? 0;

		return { collapsedTurns, summaryOpen, heroesPinned, openTools, openToolGroups, openThinking, expandedText, previewToggles, scrollTop };
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
		if (state.heroesPinned) {
			const pinnedEl = this.timelineEl?.querySelector('.claude-sessions-pinned-heroes');
			pinnedEl?.addClass('is-pinned');
			const pinBtn = this.timelineEl?.querySelector('.claude-sessions-heroes-pin');
			pinBtn?.addClass('is-active');
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

		// Restore expanded tool groups
		for (const key of state.openToolGroups) {
			const [t, g] = key.split('-').map(Number);
			if (t < turnEls.length) {
				const groups = turnEls[t].querySelectorAll('.claude-sessions-tool-group');
				if (g < groups.length) {
					groups[g].addClass('open');
					const header = groups[g].querySelector('.claude-sessions-tool-group-header');
					header?.setAttribute('aria-expanded', 'true');
				}
			}
		}

		// Restore expanded thinking blocks
		for (const key of state.openThinking) {
			const [t, k] = key.split('-').map(Number);
			if (t < turnEls.length) {
				const thinking = turnEls[t].querySelectorAll('.claude-sessions-thinking-block');
				if (k < thinking.length) {
					thinking[k].addClass('open');
					const header = thinking[k].querySelector('.claude-sessions-thinking-header');
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
						btn.setAttribute('aria-expanded', 'true');
					}
				}
			}
		}

		// Restore markdown preview toggles (click the preview button to trigger lazy render)
		for (const key of state.previewToggles) {
			const [t, m] = key.split('-').map(Number);
			if (t < turnEls.length) {
				const toggles = turnEls[t].querySelectorAll('.claude-sessions-read-md-toggle');
				if (m < toggles.length) {
					const previewBtn = toggles[m].querySelector<HTMLElement>('.claude-sessions-read-md-btn:last-child');
					previewBtn?.click();
				}
			}
		}

		// Restore scroll position
		if (this.timelineEl) {
			this.timelineEl.scrollTop = state.scrollTop;
		}
	}

	/** Capture expand/collapse state for a single turn element. */
	private captureTurnState(el: HTMLElement): {
		collapsed: boolean;
		openTools: number[];
		openGroups: number[];
		openThinking: number[];
		expandedWraps: number[];
		previewToggles: number[];
	} {
		const openTools: number[] = [];
		el.querySelectorAll('.claude-sessions-tool-block').forEach((b, i) => {
			if (b.hasClass('open')) openTools.push(i);
		});
		const openGroups: number[] = [];
		el.querySelectorAll('.claude-sessions-tool-group').forEach((g, i) => {
			if (g.hasClass('open')) openGroups.push(i);
		});
		const openThinking: number[] = [];
		el.querySelectorAll('.claude-sessions-thinking-block').forEach((t, i) => {
			if (t.hasClass('open')) openThinking.push(i);
		});
		const expandedWraps: number[] = [];
		el.querySelectorAll('.claude-sessions-collapsible-wrap').forEach((w, i) => {
			if (!w.hasClass('is-collapsed')) expandedWraps.push(i);
		});
		const previewToggles: number[] = [];
		el.querySelectorAll('.claude-sessions-read-md-toggle').forEach((t, i) => {
			const code = t.querySelector('.claude-sessions-read-md-code');
			if (code?.hasClass('claude-sessions-read-md-hidden')) previewToggles.push(i);
		});
		return {
			collapsed: el.hasClass('collapsed'),
			openTools, openGroups, openThinking, expandedWraps, previewToggles,
		};
	}

	/** Restore expand/collapse state onto a (re-rendered) turn element. */
	private restoreTurnState(el: HTMLElement, state: ReturnType<typeof TimelineView.prototype.captureTurnState>): void {
		if (state.collapsed) {
			el.addClass('collapsed');
			const chevron = el.querySelector('.claude-sessions-turn-chevron');
			if (chevron) chevron.textContent = '\u25B6';
			el.querySelector('.claude-sessions-turn-header')?.setAttribute('aria-expanded', 'false');
		}
		const toolBlocks = el.querySelectorAll('.claude-sessions-tool-block');
		for (const i of state.openTools) {
			if (i < toolBlocks.length) {
				toolBlocks[i].addClass('open');
				toolBlocks[i].querySelector('.claude-sessions-tool-header')?.setAttribute('aria-expanded', 'true');
			}
		}
		const groups = el.querySelectorAll('.claude-sessions-tool-group');
		for (const i of state.openGroups) {
			if (i < groups.length) {
				groups[i].addClass('open');
				groups[i].querySelector('.claude-sessions-tool-group-header')?.setAttribute('aria-expanded', 'true');
			}
		}
		const thinking = el.querySelectorAll('.claude-sessions-thinking-block');
		for (const i of state.openThinking) {
			if (i < thinking.length) {
				thinking[i].addClass('open');
				thinking[i].querySelector('.claude-sessions-thinking-header')?.setAttribute('aria-expanded', 'true');
			}
		}
		const wraps = el.querySelectorAll('.claude-sessions-collapsible-wrap');
		for (const i of state.expandedWraps) {
			if (i < wraps.length) {
				wraps[i].removeClass('is-collapsed');
				const btn = wraps[i].querySelector('.claude-sessions-collapsible-toggle');
				if (btn) {
					btn.textContent = 'Show less';
					btn.setAttribute('aria-expanded', 'true');
				}
			}
		}
		const toggles = el.querySelectorAll('.claude-sessions-read-md-toggle');
		for (const i of state.previewToggles) {
			if (i < toggles.length) {
				toggles[i].querySelector<HTMLElement>('.claude-sessions-read-md-btn:last-child')?.click();
			}
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
					if (entry.isIntersecting) {
						entry.target.addClass('visible');
					} else {
						entry.target.removeClass('visible');
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
		const dots = this.progressBar.querySelectorAll<HTMLElement>('.claude-sessions-turn-dot');
		dots.forEach((dot) => {
			const idx = parseInt(dot.dataset.turnIndex || '0', 10);
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
		searchBtn.addEventListener('click', () => void this.openInSessionSearch());

		// Filter button
		const filterBtn = row.createEl('button', {
			cls: 'claude-sessions-ctrl-btn claude-sessions-filter-btn',
			attr: { 'aria-label': 'Filter content', 'data-tooltip-position': 'top' },
			text: '\u22EF',
		});
		makeClickable(filterBtn, { label: 'Filter content', expanded: false });
		filterBtn.addEventListener('click', (e: MouseEvent) => {
			this.showFilterMenu(e);
		});

		// Watch button
		this.watchBtn = row.createEl('button', {
			cls: 'claude-sessions-ctrl-btn claude-sessions-watch-btn',
			attr: { 'aria-label': 'Start live watch', 'data-tooltip-position': 'top' },
		});
		setIcon(this.watchBtn, 'radio');
		this.watchBtn.addEventListener('click', () => this.toggleWatch());

		// Progress bar (read-only indicator — not keyboard-focusable; scroll observer updates position)
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

	private applyFilters(root?: HTMLElement): void {
		const scope = root ?? this.timelineEl;
		if (!scope) return;
		const f = this.filters;

		// ── User section (parent toggle) ──
		scope.querySelectorAll<HTMLElement>('.claude-sessions-role-user').forEach(el => {
			el.toggleClass('claude-sessions-filtered', !f.user);
		});

		// User children (only matter when parent is on)
		if (f.user) {
			scope.querySelectorAll('.claude-sessions-user-text').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.userText);
			});
			scope.querySelectorAll('.claude-sessions-slash-command-block').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.userText);
			});
			scope.querySelectorAll('.claude-sessions-bash-command-block').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.userText);
			});
			scope.querySelectorAll('.claude-sessions-image-thumbnail').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.userImages);
			});
		}

		// ── Assistant section (parent toggle) ──
		scope.querySelectorAll<HTMLElement>('.claude-sessions-role-assistant').forEach(el => {
			el.toggleClass('claude-sessions-filtered', !f.assistant);
		});

		// Assistant children (only matter when parent is on)
		if (f.assistant) {
			scope.querySelectorAll('.claude-sessions-assistant-text').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.assistantText);
			});
			scope.querySelectorAll('.claude-sessions-thinking-block').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.thinking);
			});
			scope.querySelectorAll('.claude-sessions-tool-block, .claude-sessions-tool-group').forEach(el => {
				const wrapper = el.closest<HTMLElement>('.claude-sessions-block-wrapper');
				wrapper?.toggleClass('claude-sessions-filtered', !f.toolCalls);
			});
			scope.querySelectorAll<HTMLElement>('.claude-sessions-tool-result').forEach(el => {
				el.toggleClass('claude-sessions-filtered', !f.toolResults);
			});
		}

		// Update filter button appearance (only when running on full timeline)
		if (!root) {
			const allOn = f.user && f.assistant && f.userText && f.userImages
				&& f.assistantText && f.thinking && f.toolCalls && f.toolResults;
			this.controlsEl?.querySelector('.claude-sessions-filter-btn')
				?.toggleClass('claude-sessions-filter-active', !allOn);
		}
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
