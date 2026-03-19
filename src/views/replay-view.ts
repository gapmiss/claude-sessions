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
	private currentTurn = 0;
	private renderer: ReplayRenderer | null = null;
	private settings: PluginSettings;
	private isPlaying = false;
	private playTimer: number | null = null;
	private controlsEl: HTMLElement | null = null;
	private turnContentEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private progressEl: HTMLInputElement | null = null;
	private playBtn: HTMLButtonElement | null = null;

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

		// Controls bar
		this.controlsEl = contentEl.createDiv({ cls: 'agent-sessions-controls' });
		this.buildControls(this.controlsEl);

		// Turn content area
		this.turnContentEl = contentEl.createDiv({ cls: 'agent-sessions-content' });
		this.renderer = new ReplayRenderer(this.turnContentEl, this.app, this, this.settings);

		if (!this.session) {
			this.turnContentEl.createDiv({
				cls: 'agent-sessions-empty',
				text: 'No session loaded. Use "Browse agent sessions" or "Import session file" to load one.',
			});
		}
	}

	async onClose(): Promise<void> {
		this.stopPlayback();
	}

	getState(): Record<string, unknown> {
		return {
			sessionPath: this.session?.rawPath,
			turnIndex: this.currentTurn,
		};
	}

	async setState(state: ReplayViewState): Promise<void> {
		if (state.turnIndex !== undefined) {
			this.currentTurn = state.turnIndex;
		}
		if (this.session && this.renderer) {
			this.renderCurrentTurn();
		}
	}

	loadSession(session: Session): void {
		this.session = session;
		this.currentTurn = 0;
		this.stopPlayback();

		if (this.renderer) {
			this.renderer.updateSettings(this.settings);
		}

		// Trigger display text refresh
		(this.leaf as unknown as { updateHeader?(): void }).updateHeader?.();

		this.renderCurrentTurn();
		this.updateControls();
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		if (this.renderer) {
			this.renderer.updateSettings(settings);
			if (this.session) {
				this.renderCurrentTurn();
			}
		}
	}

	getSession(): Session | null {
		return this.session;
	}

	// Navigation
	goToTurn(index: number): void {
		if (!this.session) return;
		this.currentTurn = Math.max(0, Math.min(index, this.session.turns.length - 1));
		this.renderCurrentTurn();
		this.updateControls();
	}

	nextTurn(): void {
		this.goToTurn(this.currentTurn + 1);
	}

	prevTurn(): void {
		this.goToTurn(this.currentTurn - 1);
	}

	// Playback
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
		this.updatePlayButton();

		const interval = 2000 / this.settings.playbackSpeed;
		this.playTimer = window.setInterval(() => {
			if (!this.session) {
				this.stopPlayback();
				return;
			}
			if (this.currentTurn >= this.session.turns.length - 1) {
				this.stopPlayback();
				return;
			}
			this.nextTurn();
		}, interval);

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
	private renderCurrentTurn(): void {
		if (!this.session || !this.renderer || !this.turnContentEl) return;

		if (this.session.turns.length === 0) {
			this.turnContentEl.empty();
			this.turnContentEl.createDiv({
				cls: 'agent-sessions-empty',
				text: 'This session has no turns.',
			});
			return;
		}

		const turn = this.session.turns[this.currentTurn];
		if (turn) {
			this.renderer.renderTurn(turn);
		}
	}

	// Controls
	private buildControls(container: HTMLElement): void {
		// Navigation buttons
		const navGroup = container.createDiv({ cls: 'agent-sessions-nav-group' });

		const prevBtn = navGroup.createEl('button', {
			cls: 'agent-sessions-btn',
			attr: { 'aria-label': 'Previous turn', 'data-tooltip-position': 'top' },
		});
		prevBtn.setText('\u25C0');
		prevBtn.addEventListener('click', () => this.prevTurn());

		this.playBtn = navGroup.createEl('button', {
			cls: 'agent-sessions-btn agent-sessions-play-btn',
			attr: { 'aria-label': 'Play/pause', 'data-tooltip-position': 'top' },
		});
		this.playBtn.setText('\u25B6');
		this.playBtn.addEventListener('click', () => this.togglePlayback());

		const nextBtn = navGroup.createEl('button', {
			cls: 'agent-sessions-btn',
			attr: { 'aria-label': 'Next turn', 'data-tooltip-position': 'top' },
		});
		nextBtn.setText('\u25B6');
		nextBtn.addEventListener('click', () => this.nextTurn());

		// Progress bar
		this.progressEl = container.createEl('input', {
			cls: 'agent-sessions-progress',
			attr: {
				type: 'range',
				min: '0',
				max: '0',
				value: '0',
				'aria-label': 'Turn progress',
			},
		}) as HTMLInputElement;
		this.progressEl.addEventListener('input', () => {
			this.goToTurn(parseInt(this.progressEl!.value, 10));
		});

		// Status
		this.statusEl = container.createDiv({ cls: 'agent-sessions-status' });

		// Speed controls
		const speedGroup = container.createDiv({ cls: 'agent-sessions-speed-group' });
		const speeds = [0.5, 1, 2, 5];
		for (const speed of speeds) {
			const btn = speedGroup.createEl('button', {
				cls: 'agent-sessions-btn agent-sessions-speed-btn',
				text: `${speed}x`,
				attr: {
					'aria-label': `Playback speed ${speed}x`,
					'data-tooltip-position': 'top',
				},
			});
			btn.addEventListener('click', () => this.setSpeed(speed));
		}

		// Keyboard shortcuts
		this.registerDomEvent(container.doc, 'keydown', (e: KeyboardEvent) => {
			if (!this.session) return;
			// Only handle if this view is active
			const activeView = this.app.workspace.getActiveViewOfType(ReplayView);
			if (activeView !== this) return;

			switch (e.key) {
				case 'ArrowLeft':
					e.preventDefault();
					this.prevTurn();
					break;
				case 'ArrowRight':
					e.preventDefault();
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
		if (this.progressEl) {
			this.progressEl.max = String(Math.max(0, total - 1));
			this.progressEl.value = String(this.currentTurn);
		}

		if (this.statusEl) {
			this.statusEl.setText(
				`Turn ${this.currentTurn + 1} / ${total} \u00B7 ${this.settings.playbackSpeed}x`
			);
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
			const speed = parseFloat(btn.textContent?.replace('x', '') || '1');
			btn.toggleClass('agent-sessions-speed-active', speed === this.settings.playbackSpeed);
		});
	}
}
