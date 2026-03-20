import { ItemView, Menu, WorkspaceLeaf } from 'obsidian';
import { Session, ContentBlock, PluginSettings } from '../types';
import { ReplayRenderer } from './replay-renderer';

export const VIEW_TYPE_REPLAY = 'agent-sessions-replay';

interface ReplayViewState {
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

export class ReplayView extends ItemView {
	private session: Session | null = null;
	private renderer: ReplayRenderer | null = null;
	private settings: PluginSettings;
	private isPlaying = false;
	private playTimer: number | null = null;
	private playIndex = 0;
	private controlsEl: HTMLElement | null = null;
	private timelineEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private progressBar: HTMLElement | null = null;
	private progressTooltip: HTMLElement | null = null;
	private playBtn: HTMLButtonElement | null = null;
	private observer: IntersectionObserver | null = null;
	private activeTurnIndex = 0;
	private activeBlockIdx = -1; // -1 = no block highlighted within turn

	// Timing data
	private sessionStartMs = 0;
	private sessionTotalMs = 0;
	private turnStartMs: number[] = [];
	private turnEndMs: number[] = [];
	private displayedTimeMs = 0;

	// Segment-level timing (flat across all turns)
	private segmentMs: number[] = [];
	private segmentStartIdx: number[] = []; // first flat index per turn

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
		return VIEW_TYPE_REPLAY;
	}

	getDisplayText(): string {
		if (this.session) {
			return `Session: ${this.session.metadata.project}`;
		}
		return 'Agent session';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('agent-sessions-replay-container');

		// Timeline area (scrollable)
		this.timelineEl = contentEl.createDiv({ cls: 'agent-sessions-timeline markdown-rendered' });
		this.renderer = new ReplayRenderer(this.timelineEl, this.app, this, this.settings);

		// Controls bar (fixed at bottom)
		this.controlsEl = contentEl.createDiv({ cls: 'agent-sessions-controls' });
		this.buildControls(this.controlsEl);

		if (!this.session) {
			this.timelineEl.createDiv({
				cls: 'agent-sessions-empty',
				text: 'No session loaded. Use "Browse agent sessions" or "Import session file" to load one.',
			});
		}
	}

	async onClose(): Promise<void> {
		this.stopPlayback();
		this.destroyObserver();
	}

	getState(): Record<string, unknown> {
		return {
			sessionPath: this.session?.rawPath,
			turnIndex: this.activeTurnIndex,
		};
	}

	async setState(state: ReplayViewState): Promise<void> {
		if (state.turnIndex !== undefined && this.session) {
			this.scrollToTurn(state.turnIndex);
		}
	}

	loadSession(session: Session): void {
		this.session = session;
		this.playIndex = 0;
		this.activeTurnIndex = 0;
		this.activeBlockIdx = -1;
		this.stopPlayback();

		if (this.renderer) {
			this.renderer.updateSettings(this.settings);
		}

		this.computeTiming();

		(this.leaf as unknown as { updateHeader?(): void }).updateHeader?.();

		this.renderFullTimeline();
		this.renderSegmentDots();
		this.syncTimer();
		this.updateControls();
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		if (this.renderer) {
			this.renderer.updateSettings(settings);
			if (this.session) {
				const savedIndex = this.activeTurnIndex;
				this.renderFullTimeline();
				this.renderSegmentDots();
				this.scrollToTurn(savedIndex);
				this.updateControls();
			}
		}
	}

	getSession(): Session | null {
		return this.session;
	}

	getSessionStartMs(): number {
		return this.sessionStartMs;
	}

	// Navigation — scroll to a specific turn
	scrollToTurn(index: number): void {
		if (!this.session) return;
		const target = Math.max(0, Math.min(index, this.session.turns.length - 1));
		this.clearActiveBlock();
		const turnEls = this.renderer?.getTurnElements() || [];
		const el = turnEls[target];
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
		this.playIndex = target;
		this.activeTurnIndex = target;
		this.activeBlockIdx = -1;
		this.syncTimer();
		this.updateControls();
	}

	nextTurn(): void {
		this.stepForward();
	}

	prevTurn(): void {
		this.stepBack();
	}

	private stepForward(): void {
		if (!this.session) return;
		const turnEls = this.renderer?.getTurnElements() || [];
		const wrappers = this.getBlockWrappers(turnEls[this.activeTurnIndex]);

		if (this.activeBlockIdx < wrappers.length - 1) {
			// Move to next block within current turn
			this.setActiveBlock(this.activeTurnIndex, this.activeBlockIdx + 1);
		} else if (this.activeTurnIndex < this.session.turns.length - 1) {
			// Move to first block of next turn
			this.setActiveBlock(this.activeTurnIndex + 1, 0);
		}
	}

	private stepBack(): void {
		if (!this.session) return;

		if (this.activeBlockIdx > 0) {
			// Move to previous block within current turn
			this.setActiveBlock(this.activeTurnIndex, this.activeBlockIdx - 1);
		} else if (this.activeTurnIndex > 0) {
			// Move to last block of previous turn
			const turnEls = this.renderer?.getTurnElements() || [];
			const prevWrappers = this.getBlockWrappers(turnEls[this.activeTurnIndex - 1]);
			this.setActiveBlock(this.activeTurnIndex - 1, Math.max(0, prevWrappers.length - 1));
		}
	}

	/**
	 * Move the active highlight to a specific block within a specific turn.
	 */
	private setActiveBlock(turnIdx: number, blockIdx: number): void {
		// Clear previous active block
		this.clearActiveBlock();

		this.activeTurnIndex = turnIdx;
		this.activeBlockIdx = blockIdx;

		const turnEls = this.renderer?.getTurnElements() || [];
		const turnEl = turnEls[turnIdx];
		if (!turnEl) return;

		const wrappers = this.getBlockWrappers(turnEl);
		const target = wrappers[blockIdx];
		if (target) {
			target.addClass('agent-sessions-block-active');
			target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}

		this.syncTimerToBlock();
		this.updateControls();
	}

	private clearActiveBlock(): void {
		if (!this.timelineEl) return;
		this.timelineEl.querySelectorAll('.agent-sessions-block-active').forEach(el => {
			el.removeClass('agent-sessions-block-active');
		});
	}

	private getBlockWrappers(turnEl: HTMLElement | undefined): HTMLElement[] {
		if (!turnEl) return [];
		return Array.from(turnEl.querySelectorAll('.agent-sessions-block-wrapper')) as HTMLElement[];
	}

	// Timing computation
	private computeTiming(): void {
		this.turnStartMs = [];
		this.turnEndMs = [];
		this.sessionStartMs = 0;
		this.sessionTotalMs = 0;
		this.displayedTimeMs = 0;

		if (!this.session || this.session.turns.length === 0) return;

		// Determine session start from metadata or first turn
		const startStr = this.session.metadata.startTime
			|| this.session.turns[0].timestamp;
		if (!startStr) return; // no timestamps available

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

		this.computeSegmentTiming();
	}

	/**
	 * Build flat array of segment timestamps across all turns.
	 * One entry per block-wrapper in the DOM, ordered by turn then block index.
	 */
	private computeSegmentTiming(): void {
		this.segmentMs = [];
		this.segmentStartIdx = [];
		if (!this.session) return;

		for (let t = 0; t < this.session.turns.length; t++) {
			this.segmentStartIdx[t] = this.segmentMs.length;
			const turn = this.session.turns[t];
			const turnMs = this.turnStartMs[t] || 0;

			if (turn.role === 'user') {
				// User turns: one wrapper per text block
				const textBlocks = turn.contentBlocks.filter(b => b.type === 'text');
				if (textBlocks.length === 0) {
					this.segmentMs.push(turnMs);
				} else {
					for (const b of textBlocks) {
						const ms = b.timestamp
							? new Date(b.timestamp).getTime() - this.sessionStartMs
							: NaN;
						this.segmentMs.push(!isNaN(ms) ? ms : turnMs);
					}
				}
			} else {
				// Assistant turns: groups consecutive tool_use/result into one segment
				const timestamps = this.buildSegmentTimestamps(turn.contentBlocks);
				if (timestamps.length === 0) {
					this.segmentMs.push(turnMs);
				} else {
					for (const ts of timestamps) {
						const ms = ts
							? new Date(ts).getTime() - this.sessionStartMs
							: NaN;
						this.segmentMs.push(!isNaN(ms) ? ms : turnMs);
					}
				}
			}
		}
	}

	private syncTimer(): void {
		if (this.segmentMs.length > 0 && this.segmentStartIdx.length > this.activeTurnIndex) {
			this.displayedTimeMs = this.segmentMs[this.segmentStartIdx[this.activeTurnIndex]] || 0;
		} else if (this.turnStartMs.length > 0) {
			this.displayedTimeMs = this.turnStartMs[this.activeTurnIndex] || 0;
		}
	}

	private syncTimerToBlock(): void {
		if (this.segmentMs.length === 0 || !this.session) return;
		const startIdx = this.segmentStartIdx[this.activeTurnIndex] || 0;
		const flatIdx = startIdx + Math.max(0, this.activeBlockIdx);
		if (flatIdx < this.segmentMs.length) {
			this.displayedTimeMs = this.segmentMs[flatIdx];
		}
	}

	/**
	 * On free scroll (no playback, no active block), update timer from topmost visible wrapper.
	 */
	private syncTimerToScroll(): void {
		if (!this.timelineEl || !this.session || this.segmentMs.length === 0) return;

		const timelineRect = this.timelineEl.getBoundingClientRect();
		const turnEls = this.renderer?.getTurnElements() || [];
		const turnEl = turnEls[this.activeTurnIndex];
		if (!turnEl) return;

		const wrappers = this.getBlockWrappers(turnEl);
		const startIdx = this.segmentStartIdx[this.activeTurnIndex] || 0;

		// Find the wrapper closest to the top third of the viewport
		const threshold = timelineRect.top + timelineRect.height / 3;
		let bestIdx = 0;
		for (let i = 0; i < wrappers.length; i++) {
			if (wrappers[i].getBoundingClientRect().top <= threshold) {
				bestIdx = i;
			}
		}

		const flatIdx = startIdx + bestIdx;
		if (flatIdx < this.segmentMs.length) {
			this.displayedTimeMs = this.segmentMs[flatIdx];
			this.updateControls();
		}
	}

	/**
	 * Map a progress bar percentage to a segment location.
	 */
	private segmentFromPct(pct: number): { turnIdx: number; blockIdx: number } {
		if (this.segmentMs.length === 0) return { turnIdx: 0, blockIdx: 0 };

		let flatIdx: number;
		if (this.sessionTotalMs > 0) {
			const targetMs = pct * this.sessionTotalMs;
			flatIdx = this.segmentMs.findIndex((ms, i) =>
				i === this.segmentMs.length - 1 || this.segmentMs[i + 1] > targetMs
			);
			if (flatIdx < 0) flatIdx = 0;
		} else {
			flatIdx = Math.round(pct * (this.segmentMs.length - 1));
		}

		// Find which turn owns this flat index
		let turnIdx = 0;
		for (let t = 0; t < this.segmentStartIdx.length; t++) {
			if (this.segmentStartIdx[t] <= flatIdx) {
				turnIdx = t;
			} else {
				break;
			}
		}
		const blockIdx = flatIdx - (this.segmentStartIdx[turnIdx] || 0);
		return { turnIdx, blockIdx };
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

	// Playback — auto-scroll through the timeline (time-based)
	togglePlayback(): void {
		if (this.isPlaying) {
			this.stopPlayback();
		} else {
			this.startPlayback();
		}
	}

	private startPlayback(): void {
		if (!this.session) return;
		this.isPlaying = true;
		this.playIndex = this.activeTurnIndex;
		this.updatePlayButton();
		this.animateCurrentTurn();
	}

	private animateCurrentTurn(): void {
		if (!this.session || !this.isPlaying) return;
		const turnEls = this.renderer?.getTurnElements() || [];
		const turnEl = turnEls[this.playIndex];
		if (!turnEl) {
			this.advanceToNextTurn();
			return;
		}

		const wrappers = this.getBlockWrappers(turnEl);
		const turn = this.session.turns[this.playIndex];
		const gaps = this.computeSegmentGaps(turn.contentBlocks, wrappers.length);

		// Start from the block after the current active one, or 0
		const startIdx = (this.playIndex === this.activeTurnIndex && this.activeBlockIdx >= 0)
			? this.activeBlockIdx + 1
			: 0;

		this.playNextSegment(wrappers, gaps, startIdx);
	}

	private playNextSegment(
		wrappers: HTMLElement[],
		gaps: number[],
		idx: number
	): void {
		if (!this.isPlaying) return;

		if (idx >= wrappers.length) {
			// All segments in this turn visited — dwell then advance
			this.playTimer = window.setTimeout(
				() => this.advanceToNextTurn(),
				500 / this.settings.playbackSpeed
			);
			this.registerInterval(this.playTimer);
			return;
		}

		const delayMs = gaps[idx] / this.settings.playbackSpeed;
		this.playTimer = window.setTimeout(() => {
			if (!this.isPlaying) return;
			this.setActiveBlock(this.playIndex, idx);
			this.playNextSegment(wrappers, gaps, idx + 1);
		}, delayMs);
		this.registerInterval(this.playTimer);
	}

	private advanceToNextTurn(): void {
		if (!this.session || !this.isPlaying) return;
		this.playIndex++;
		if (this.playIndex >= this.session.turns.length) {
			this.stopPlayback();
			return;
		}
		this.animateCurrentTurn();
	}

	/**
	 * Build segment grouping from content blocks to compute timestamp gaps.
	 * Groups consecutive tool_use/tool_result into a single segment (matching renderer logic).
	 * Returns array of timestamps (one per segment/wrapper).
	 */
	private buildSegmentTimestamps(blocks: ContentBlock[]): (string | undefined)[] {
		const timestamps: (string | undefined)[] = [];
		let inToolRun = false;

		for (const block of blocks) {
			if (block.type === 'tool_use' || block.type === 'tool_result') {
				if (!inToolRun) {
					// Start of a new tool run segment — use the first tool_use timestamp
					timestamps.push(block.timestamp);
					inToolRun = true;
				}
			} else {
				inToolRun = false;
				timestamps.push(block.timestamp);
			}
		}
		return timestamps;
	}

	/**
	 * Compute delays between segments for playback.
	 * First segment: 0ms. Others: real timestamp gap clamped to [600, 10000], fallback 800ms.
	 */
	private computeSegmentGaps(blocks: ContentBlock[], wrapperCount: number): number[] {
		const timestamps = this.buildSegmentTimestamps(blocks);
		const gaps: number[] = [];

		for (let i = 0; i < wrapperCount; i++) {
			if (i === 0) {
				gaps.push(0);
				continue;
			}

			const prevTs = timestamps[i - 1];
			const currTs = timestamps[i];
			if (prevTs && currTs) {
				const prevMs = new Date(prevTs).getTime();
				const currMs = new Date(currTs).getTime();
				if (!isNaN(prevMs) && !isNaN(currMs)) {
					const gap = currMs - prevMs;
					gaps.push(Math.max(600, Math.min(gap, 10000)));
					continue;
				}
			}
			gaps.push(800); // fallback
		}
		return gaps;
	}

	private stopPlayback(): void {
		this.isPlaying = false;
		if (this.playTimer !== null) {
			window.clearTimeout(this.playTimer);
			this.playTimer = null;
		}
		this.clearActiveBlock();
		this.activeBlockIdx = -1;
		this.updatePlayButton();
	}

	setSpeed(speed: number): void {
		this.settings.playbackSpeed = speed;
		if (this.isPlaying) {
			this.stopPlayback();
			this.startPlayback();
		}
		this.updateControls();
	}

	// Rendering
	private renderFullTimeline(): void {
		if (!this.session || !this.renderer || !this.timelineEl) return;
		this.destroyObserver();

		if (this.session.turns.length === 0) {
			this.timelineEl.empty();
			this.timelineEl.createDiv({
				cls: 'agent-sessions-empty',
				text: 'This session has no turns.',
			});
			return;
		}

		// Render all turns into the timeline
		this.renderer.renderTimeline(this.session.turns, this.sessionStartMs);

		// Set up IntersectionObserver for scroll-based opacity
		this.setupScrollObserver();
	}

	private setupScrollObserver(): void {
		if (!this.timelineEl) return;

		const turnEls = this.renderer?.getTurnElements() || [];
		if (turnEls.length === 0) return;

		// Use IntersectionObserver to detect which turns are in view
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

				// Check if scrolled to bottom
				const scrollEl = this.timelineEl;
				const atBottom = scrollEl
					? scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 30
					: false;

				// If at bottom, use last visible turn; otherwise use topmost
				let active = -1;
				if (atBottom) {
					for (let i = turnEls.length - 1; i >= 0; i--) {
						if (turnEls[i].hasClass('visible')) { active = i; break; }
					}
				} else {
					for (let i = 0; i < turnEls.length; i++) {
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

		// Live scroll → update timer from topmost visible segment
		this.registerDomEvent(this.timelineEl, 'scroll', () => {
			if (this.isPlaying || this.activeBlockIdx >= 0) return;
			this.syncTimerToScroll();
		});
	}

	private destroyObserver(): void {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
	}

	// Segment dots on progress bar
	private renderSegmentDots(): void {
		if (!this.session || !this.progressBar) return;
		this.progressBar.querySelectorAll('.agent-sessions-turn-dot').forEach(d => d.remove());

		const total = this.segmentMs.length;
		if (total === 0) return;

		for (let i = 0; i < total; i++) {
			const dot = this.progressBar.createDiv({ cls: 'agent-sessions-turn-dot' });
			const pct = this.sessionTotalMs > 0
				? (this.segmentMs[i] / this.sessionTotalMs) * 100
				: (total > 1 ? (i / (total - 1)) * 100 : 0);
			dot.style.left = `${pct}%`;
			dot.dataset.segmentIndex = String(i);
		}
	}

	private updateSegmentDots(): void {
		if (!this.progressBar) return;
		const dots = this.progressBar.querySelectorAll('.agent-sessions-turn-dot');
		dots.forEach((dot) => {
			const idx = parseInt((dot as HTMLElement).dataset.segmentIndex || '0', 10);
			dot.toggleClass('reached', this.segmentMs[idx] <= this.displayedTimeMs);
		});
	}

	// Controls
	private buildControls(container: HTMLElement): void {
		const row = container.createDiv({ cls: 'agent-sessions-controls-row' });

		// Nav buttons
		const prevBtn = row.createEl('button', {
			cls: 'agent-sessions-ctrl-btn',
			attr: { 'aria-label': 'Previous turn', 'data-tooltip-position': 'top' },
			text: '\u2190',
		});
		prevBtn.addEventListener('click', () => {
			this.stopPlayback();
			this.prevTurn();
		});

		this.playBtn = row.createEl('button', {
			cls: 'agent-sessions-ctrl-btn agent-sessions-play-btn',
			attr: { 'aria-label': 'Play/pause', 'data-tooltip-position': 'top' },
			text: '\u25B6',
		});
		this.playBtn.addEventListener('click', () => this.togglePlayback());

		const nextBtn = row.createEl('button', {
			cls: 'agent-sessions-ctrl-btn',
			attr: { 'aria-label': 'Next turn', 'data-tooltip-position': 'top' },
			text: '\u2192',
		});
		nextBtn.addEventListener('click', () => {
			this.stopPlayback();
			this.nextTurn();
		});

		// Status text
		this.statusEl = row.createSpan({ cls: 'agent-sessions-progress-text' });

		// Speed controls
		const speedWrap = row.createDiv({ cls: 'agent-sessions-speed-wrap' });
		const speeds = [0.5, 1, 2, 3, 5];
		for (const s of speeds) {
			const btn = speedWrap.createEl('button', {
				cls: 'agent-sessions-ctrl-btn agent-sessions-speed-btn',
				text: `${s}x`,
				attr: { 'aria-label': `Speed ${s}x`, 'data-tooltip-position': 'top', 'data-speed': String(s) },
			});
			btn.addEventListener('click', () => this.setSpeed(s));
		}

		// Filter button
		const filterBtn = row.createEl('button', {
			cls: 'agent-sessions-ctrl-btn agent-sessions-filter-btn',
			attr: { 'aria-label': 'Filter content', 'data-tooltip-position': 'top' },
			text: '\u22EF',
		});
		filterBtn.addEventListener('click', (e: MouseEvent) => {
			this.showFilterMenu(e);
		});

		// Progress bar
		const progressWrap = container.createDiv({ cls: 'agent-sessions-progress-wrap' });
		this.progressBar = progressWrap.createDiv({ cls: 'agent-sessions-progress-bar' });
		this.progressFill = this.progressBar.createDiv({ cls: 'agent-sessions-progress-fill' });

		// Tooltip
		this.progressTooltip = this.progressBar.createDiv({ cls: 'agent-sessions-progress-tooltip' });

		// Hover tooltip on progress bar
		this.progressBar.addEventListener('mousemove', (e: MouseEvent) => {
			if (!this.session || !this.progressTooltip) return;
			const rect = this.progressBar!.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

			const { turnIdx } = this.segmentFromPct(pct);
			let label = `#${turnIdx + 1}`;
			if (this.turnStartMs[turnIdx] !== undefined && this.sessionTotalMs > 0) {
				const ms = pct * this.sessionTotalMs;
				label += ` \u00B7 ${this.formatTime(ms)}`;
			}
			this.progressTooltip.setText(label);
			const left = Math.max(20, Math.min(rect.width - 20, e.clientX - rect.left));
			this.progressTooltip.style.left = `${left}px`;
		});

		// Click on progress bar to seek (segment-level)
		this.progressBar.addEventListener('click', (e: MouseEvent) => {
			if (!this.session) return;
			this.stopPlayback();
			const rect = this.progressBar!.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

			const { turnIdx, blockIdx } = this.segmentFromPct(pct);
			this.setActiveBlock(turnIdx, blockIdx);
		});

		// Keyboard shortcuts
		this.registerDomEvent(container.doc, 'keydown', (e: KeyboardEvent) => {
			if (!this.session) return;
			const activeView = this.app.workspace.getActiveViewOfType(ReplayView);
			if (activeView !== this) return;

			switch (e.key) {
				case 'ArrowLeft':
					e.preventDefault();
					this.stopPlayback();
					this.prevTurn();
					break;
				case 'ArrowRight':
					e.preventDefault();
					this.stopPlayback();
					this.nextTurn();
					break;
				case ' ':
					e.preventDefault();
					this.togglePlayback();
					break;
				case '[':
					e.preventDefault();
					this.setSpeed(Math.max(0.5, this.settings.playbackSpeed - 0.5));
					break;
				case ']':
					e.preventDefault();
					this.setSpeed(Math.min(5, this.settings.playbackSpeed + 0.5));
					break;
			}
		});
	}

	private showFilterMenu(e: MouseEvent): void {
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

		menu.showAtMouseEvent(e);
	}

	private applyFilters(): void {
		if (!this.timelineEl) return;
		const f = this.filters;

		// ── User section (parent toggle) ──
		this.timelineEl.querySelectorAll('.agent-sessions-role-user').forEach(el => {
			(el as HTMLElement).toggleClass('agent-sessions-filtered', !f.user);
		});

		// User children (only matter when parent is on)
		if (f.user) {
			this.timelineEl.querySelectorAll('.agent-sessions-user-text').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.agent-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('agent-sessions-filtered', !f.userText);
			});
			this.timelineEl.querySelectorAll('.agent-sessions-image-thumbnail').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.agent-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('agent-sessions-filtered', !f.userImages);
			});
		}

		// ── Assistant section (parent toggle) ──
		this.timelineEl.querySelectorAll('.agent-sessions-role-assistant').forEach(el => {
			(el as HTMLElement).toggleClass('agent-sessions-filtered', !f.assistant);
		});

		// Assistant children (only matter when parent is on)
		if (f.assistant) {
			this.timelineEl.querySelectorAll('.agent-sessions-assistant-text').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.agent-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('agent-sessions-filtered', !f.assistantText);
			});
			this.timelineEl.querySelectorAll('.agent-sessions-thinking-block').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.agent-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('agent-sessions-filtered', !f.thinking);
			});
			this.timelineEl.querySelectorAll('.agent-sessions-tool-block, .agent-sessions-tool-group').forEach(el => {
				const wrapper = (el as HTMLElement).closest('.agent-sessions-block-wrapper') as HTMLElement | null;
				wrapper?.toggleClass('agent-sessions-filtered', !f.toolCalls);
			});
			this.timelineEl.querySelectorAll('.agent-sessions-tool-result').forEach(el => {
				(el as HTMLElement).toggleClass('agent-sessions-filtered', !f.toolResults);
			});
		}

		// Update filter button appearance
		const allOn = f.user && f.assistant && f.userText && f.userImages
			&& f.assistantText && f.thinking && f.toolCalls && f.toolResults;
		this.controlsEl?.querySelector('.agent-sessions-filter-btn')
			?.toggleClass('agent-sessions-filter-active', !allOn);
	}

	private updateControls(): void {
		if (!this.session) return;

		if (this.statusEl) {
			if (this.sessionTotalMs > 0) {
				this.statusEl.setText(`${this.formatTime(this.displayedTimeMs)} / ${this.formatTime(this.sessionTotalMs)}`);
			} else {
				// No timestamps — show segment position
				const flatIdx = (this.segmentStartIdx[this.activeTurnIndex] || 0)
					+ Math.max(0, this.activeBlockIdx);
				const total = this.segmentMs.length || this.session.turns.length;
				this.statusEl.setText(`${flatIdx + 1} / ${total}`);
			}
		}

		if (this.progressFill) {
			if (this.sessionTotalMs > 0) {
				const pct = (this.displayedTimeMs / this.sessionTotalMs) * 100;
				this.progressFill.style.width = `${Math.min(100, pct)}%`;
			} else if (this.segmentMs.length > 1) {
				const flatIdx = (this.segmentStartIdx[this.activeTurnIndex] || 0)
					+ Math.max(0, this.activeBlockIdx);
				const pct = (flatIdx / (this.segmentMs.length - 1)) * 100;
				this.progressFill.style.width = `${pct}%`;
			}
		}

		this.updateSegmentDots();
		this.updatePlayButton();
		this.updateSpeedButtons();
	}

	private updatePlayButton(): void {
		if (this.playBtn) {
			this.playBtn.setText(this.isPlaying ? '\u23F8' : '\u25B6');
			this.playBtn.ariaLabel = this.isPlaying ? 'Pause' : 'Play';
		}
	}

	private updateSpeedButtons(): void {
		if (!this.controlsEl) return;
		const btns = this.controlsEl.querySelectorAll('.agent-sessions-speed-btn');
		btns.forEach((btn) => {
			const s = parseFloat((btn as HTMLElement).dataset.speed || '1');
			btn.toggleClass('agent-sessions-speed-active', s === this.settings.playbackSpeed);
		});
	}
}
