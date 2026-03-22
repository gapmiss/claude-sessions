import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { SettingsTab } from './settings';
import { PluginSettings, DEFAULT_SETTINGS, Session } from './types';
import { ReplayView, VIEW_TYPE_REPLAY } from './views/replay-view';
import { SessionBrowserModal, scanSessionDirs } from './views/session-browser-modal';
import { FilePickerModal } from './views/file-picker-modal';
import { exportToMarkdown } from './exporters/markdown-exporter';
import { exportToHtml } from './exporters/html-exporter';
import { listDirectory, listSubdirectories, readFileContent } from './utils/streaming-reader';
import { detectParser } from './parsers/detect';
import { expandHome } from './utils/path-utils';

export default class AgentSessionsPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_REPLAY, (leaf: WorkspaceLeaf) => {
			return new ReplayView(leaf, this.settings);
		});

		this.addSettingTab(new SettingsTab(this.app, this));

		this.addCommand({
			id: 'browse-sessions',
			name: 'Browse sessions',
			callback: async () => {
				new Notice('Scanning session directories...');
				const entries = await scanSessionDirs(this);
				if (entries.length === 0) {
					new Notice('No sessions found. Check your session directories in settings.');
					return;
				}
				new Notice(`Found ${entries.length} sessions.`);
				new SessionBrowserModal(this.app, this, entries).open();
			},
		});

		this.addCommand({
			id: 'import-file',
			name: 'Import session file',
			callback: () => {
				new FilePickerModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'export-markdown',
			name: 'Export session to Markdown',
			callback: () => this.exportActiveSession('markdown'),
		});

		this.addCommand({
			id: 'export-html',
			name: 'Export session to HTML',
			callback: () => this.exportActiveSession('html'),
		});

		this.addCommand({
			id: 'toggle-playback',
			name: 'Toggle session playback',
			callback: () => {
				const view = this.getActiveReplayView();
				if (view) view.togglePlayback();
			},
		});

		this.addCommand({
			id: 'next-turn',
			name: 'Go to next turn',
			callback: () => {
				const view = this.getActiveReplayView();
				if (view) view.nextTurn();
			},
		});

		this.addCommand({
			id: 'prev-turn',
			name: 'Go to previous turn',
			callback: () => {
				const view = this.getActiveReplayView();
				if (view) view.prevTurn();
			},
		});
		// Protocol handler: obsidian://agent-sessions?session=/path/to/session.jsonl
		this.registerObsidianProtocolHandler('agent-sessions', async (params) => {
			const sessionPath = (params as Record<string, string>)['session'];
			if (!sessionPath) {
				new Notice('Missing session parameter in URI.');
				return;
			}
			await this.openSessionByPath(sessionPath);
		});
	}

	async openSessionByPath(sessionPath: string): Promise<void> {
		try {
			const filePath = expandHome(sessionPath);
			new Notice('Loading session...');
			const content = await readFileContent(filePath);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format.');
				return;
			}
			const session = parser.parse(content, filePath);
			await this.openSession(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}

	async onunload(): Promise<void> {
		// Leaves are not detached here — Obsidian handles cleanup,
		// and detaching resets leaf position on reload.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async openSession(session: Session): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_REPLAY,
			active: true,
		});

		const view = leaf.view;
		if (view instanceof ReplayView) {
			view.loadSession(session);
		}
	}

	updateReplayViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_REPLAY);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof ReplayView) {
				view.updateSettings(this.settings);
			}
		}
	}

	private getActiveReplayView(): ReplayView | null {
		const leaf = this.app.workspace.getActiveViewOfType(ReplayView);
		return leaf;
	}

	private async exportActiveSession(format: 'markdown' | 'html'): Promise<void> {
		const view = this.getActiveReplayView();
		if (!view) {
			new Notice('No active session to export.');
			return;
		}

		const session = view.getSession();
		if (!session) {
			new Notice('No session loaded.');
			return;
		}

		try {
			if (format === 'markdown') {
				await exportToMarkdown(this.app, session, this.settings);
			} else {
				await exportToHtml(this.app, session, this.settings);
			}
			new Notice(`Session exported as ${format}.`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Export failed: ${msg}`);
		}
	}
}
