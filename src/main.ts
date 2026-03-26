import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { SettingsTab } from './settings';
import { PluginSettings, DEFAULT_SETTINGS, Session } from './types';
import { ReplayView, VIEW_TYPE_REPLAY } from './views/replay-view';
import { SearchView, VIEW_TYPE_SEARCH } from './views/search-view';
import { SessionBrowserModal, scanSessionDirs } from './views/session-browser-modal';
import { FilePickerModal } from './views/file-picker-modal';
import { exportToMarkdown } from './exporters/markdown-exporter';
import { exportToHTML } from './exporters/html-exporter';
import { listDirectory, listSubdirectories, readFileContent } from './utils/streaming-reader';
import { detectParser } from './parsers/detect';
import { resolveSubAgentSessions } from './parsers/claude-subagent';
import { expandHome } from './utils/path-utils';
import { SessionIndex } from './utils/session-index';

export default class AgentSessionsPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	sessionIndex!: SessionIndex;

	async onload(): Promise<void> {
		await this.loadSettings();

		const adapter = this.app.vault.adapter as unknown as { basePath: string };
		this.sessionIndex = new SessionIndex(adapter.basePath, this.app.vault.configDir);

		this.registerView(VIEW_TYPE_REPLAY, (leaf: WorkspaceLeaf) => {
			return new ReplayView(leaf, this.settings);
		});

		this.registerView(VIEW_TYPE_SEARCH, (leaf: WorkspaceLeaf) => {
			return new SearchView(leaf, this);
		});

		// Forward active-leaf-change to search view for auto-scoping
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const searchLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH);
				for (const sl of searchLeaves) {
					if (sl.view instanceof SearchView) {
						(sl.view as SearchView).onActiveLeafChanged(leaf);
					}
				}
			})
		);

		this.addSettingTab(new SettingsTab(this.app, this));

		this.addCommand({
			id: 'browse-sessions',
			name: 'Browse sessions',
			callback: async () => {
				new Notice('Scanning session directories...');
				const result = await scanSessionDirs(this);
				if (result.entries.length === 0) {
					new Notice('No sessions found. Check your session directories in settings.');
					return;
				}
				if (result.updated === result.total) {
					new Notice(`Indexed ${result.total} sessions.`);
				} else {
					new Notice(`Found ${result.total} sessions (${result.updated} updated).`);
				}
				new SessionBrowserModal(this.app, this, result.entries).open();
			},
		});

		this.addCommand({
			id: 'search-sessions',
			name: 'Search sessions',
			callback: async () => {
				await this.revealSearchView('cross-session');
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
			callback: () => this.exportActiveSession(),
		});

		this.addCommand({
			id: 'export-html',
			name: 'Export session to HTML',
			callback: () => this.exportActiveSessionHTML(),
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

		this.addCommand({
			id: 'refresh-session',
			name: 'Refresh session',
			callback: async () => {
				const view = this.getActiveReplayView();
				if (view) await view.reloadSession();
			},
		});

		this.addCommand({
			id: 'toggle-live-watch',
			name: 'Toggle live watch',
			callback: () => {
				const view = this.getActiveReplayView();
				if (view) view.toggleWatch();
			},
		});

		this.addCommand({
			id: 'search-in-session',
			name: 'Search in session',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveReplayView();
				const session = view?.getSession();
				if (!view || !session?.rawPath) return false;
				if (checking) return true;
				this.revealSearchView('in-session');
				return true;
			},
		});

		// Protocol handler: obsidian://agent-sessions?session=/path/to/session.jsonl&turn=7
		this.registerObsidianProtocolHandler('agent-sessions', async (params) => {
			const p = params as Record<string, string>;
			const sessionPath = p['session'];
			if (!sessionPath) {
				new Notice('Missing session parameter.');
				return;
			}
			const turnIndex = p['turn'] ? parseInt(p['turn'], 10) : undefined;
			await this.openSessionByPath(sessionPath, turnIndex);
		});
	}

	async openSessionByPath(sessionPath: string, turnIndex?: number): Promise<void> {
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
			await resolveSubAgentSessions(session, readFileContent);
			await this.openSession(session, turnIndex);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}

	async onunload(): Promise<void> {
		// Stop all active file watchers before plugin unloads
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_REPLAY);
		for (const leaf of leaves) {
			if (leaf.view instanceof ReplayView) {
				leaf.view.stopWatching();
			}
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async openSession(session: Session, turnIndex?: number, highlightQuery?: string): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_REPLAY,
			active: true,
		});

		const view = leaf.view;
		if (view instanceof ReplayView) {
			view.loadSession(session);
			if (turnIndex !== undefined) {
				requestAnimationFrame(() => {
					view.scrollToTurn(turnIndex);
					if (highlightQuery) {
						view.navigateToMatch(turnIndex, highlightQuery);
					}
				});
			}
		}
	}

	async revealSearchView(mode: 'cross-session' | 'in-session'): Promise<SearchView> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = this.app.workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: VIEW_TYPE_SEARCH, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view as SearchView;
		view.setMode(mode);
		return view;
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

	private async exportActiveSessionHTML(): Promise<void> {
		const view = this.getActiveReplayView();
		if (!view) {
			new Notice('No active session to export.');
			return;
		}
		const session = view.getSession();
		const timelineEl = view.getTimelineEl();
		if (!session || !timelineEl) {
			new Notice('No session loaded.');
			return;
		}
		try {
			await exportToHTML(timelineEl, session, this.settings);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`HTML export failed: ${msg}`);
		}
	}

	private async exportActiveSession(): Promise<void> {
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
			await exportToMarkdown(this.app, session, this.settings);
			new Notice('Session exported as markdown.');
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Export failed: ${msg}`);
		}
	}
}
