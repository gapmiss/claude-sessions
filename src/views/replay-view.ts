import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Session, PluginSettings } from '../types';
import { ReplayRenderer } from './replay-renderer';

export const VIEW_TYPE_REPLAY = 'agent-sessions-replay';

interface ReplayViewState {
	sessionPath?: string;
	turnIndex?: number;
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
	private playBtn: HTMLButtonElement | null = null;
	private observer: IntersectionObserver | null = null;
	private activeTurnIndex = 0;

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
		this.timelineEl = contentEl.createDiv({ cls: 'agent-sessions-timeline' });
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
		this.stopPlayback();

		if (this.renderer) {
			this.renderer.updateSettings(this.settings);
		}

		(this.leaf as unknown as { updateHeader?(): void }).updateHeader?.();

		this.renderFullTimeline();
		this.updateControls();
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		if (this.renderer) {
			this.renderer.updateSettings(settings);
			if (this.session) {
				const savedIndex = this.activeTurnIndex;
				this.renderFullTimeline();
				this.scrollToTurn(savedIndex);
				this.updateControls();
			}
		}
	}

	getSession(): Session | null {
		return this.session;
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
		this.playIndex = target;
	}

	nextTurn(): void {
		this.scrollToTurn(this.activeTurnIndex + 1);
	}

	prevTurn(): void {
		this.scrollToTurn(this.activeTurnIndex - 1);
	}

	// Playback — auto-scroll through the timeline
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

		const advance = () => {
			if (!this.session || !this.isPlaying) return;
			this.playIndex++;
			if (this.playIndex >= this.session.turns.length) {
				this.stopPlayback();
				return;
			}
			this.scrollToTurn(this.playIndex);
		};

		const interval = 2000 / this.settings.playbackSpeed;
		this.playTimer = window.setInterval(advance, interval);
		this.registerInterval(this.playTimer);
	}

	private stopPlayback(): void {
		this.isPlaying = false;
		if (this.playTimer !== null) {
			window.clearInterval(this.playTimer);
			this.playTimer = null;
		}
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
		this.renderer.renderTimeline(this.session.turns);

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

				// Find the topmost visible turn to track position
				let topmost = -1;
				for (let i = 0; i < turnEls.length; i++) {
					if (turnEls[i].hasClass('visible')) {
						topmost = i;
						break;
					}
				}
				if (topmost >= 0) {
					this.activeTurnIndex = topmost;
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

		// Progress bar
		const progressWrap = container.createDiv({ cls: 'agent-sessions-progress-wrap' });
		this.progressBar = progressWrap.createDiv({ cls: 'agent-sessions-progress-bar' });
		this.progressFill = this.progressBar.createDiv({ cls: 'agent-sessions-progress-fill' });

		// Click on progress bar to seek
		this.progressBar.addEventListener('click', (e: MouseEvent) => {
			if (!this.session) return;
			this.stopPlayback();
			const rect = this.progressBar!.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const targetTurn = Math.round(pct * (this.session.turns.length - 1));
			this.scrollToTurn(targetTurn);
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

	private updateControls(): void {
		if (!this.session) return;

		const total = this.session.turns.length;
		const current = this.activeTurnIndex + 1;

		if (this.statusEl) {
			this.statusEl.setText(`${current} of ${total}`);
		}

		if (this.progressFill && total > 0) {
			const pct = total > 1 ? (this.activeTurnIndex / (total - 1)) * 100 : 100;
			this.progressFill.style.width = `${pct}%`;
		}

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
