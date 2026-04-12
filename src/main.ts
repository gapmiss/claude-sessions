import { addIcon, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { SettingsTab } from './settings';
import { PluginSettings, DEFAULT_SETTINGS, Session } from './types';
import { TimelineView, VIEW_TYPE_TIMELINE } from './views/timeline-view';
import { SearchView, VIEW_TYPE_SEARCH } from './views/search-view';
import { SessionBrowserModal, scanSessionDirs } from './views/session-browser-modal';
import { FilePickerModal } from './views/file-picker-modal';
import { exportToMarkdown } from './exporters/markdown-exporter';
import { exportToHTML } from './exporters/html-exporter';
import { readFileContent, listDirectoryFiles } from './utils/streaming-reader';
import { detectParser } from './parsers/detect';
import { resolveSubAgentSessions } from './parsers/claude-subagent';
import { expandHome } from './utils/path-utils';
import { SessionIndex } from './utils/session-index';
import { Logger } from './utils/logger';
import { ClaudeSessionsAPI, buildAPI } from './api';
import { distillSession, mergeWithClipboardContent } from './distill/distill-session';
import { installBasesTemplates } from './distill/bases-templates';

export default class ClaudeSessionsPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	sessionIndex!: SessionIndex;
	api!: ClaudeSessionsAPI;

	async onload(): Promise<void> {
		addIcon('claude-sparkle', '<g transform="translate(50,50)" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"><line y1="-12" y2="-44"/><line y1="-12" y2="-44" transform="rotate(45)"/><line y1="-12" y2="-44" transform="rotate(90)"/><line y1="-12" y2="-44" transform="rotate(135)"/><line y1="-12" y2="-44" transform="rotate(180)"/><line y1="-12" y2="-44" transform="rotate(225)"/><line y1="-12" y2="-44" transform="rotate(270)"/><line y1="-12" y2="-44" transform="rotate(315)"/></g>');

		await this.loadSettings();
		Logger.init(this.settings);

		const adapter = this.app.vault.adapter as unknown as { basePath: string };
		this.sessionIndex = new SessionIndex(adapter.basePath, this.app.vault.configDir);

		// Expose public API for inter-plugin communication
		this.api = buildAPI(this as unknown as Parameters<typeof buildAPI>[0]);

		this.registerView(VIEW_TYPE_TIMELINE, (leaf: WorkspaceLeaf) => {
			return new TimelineView(leaf, this.settings);
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
						sl.view.onActiveLeafChanged(leaf);
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
			checkCallback: (checking: boolean) => {
				if (!this.getActiveTimelineView()) return false;
				if (checking) return true;
				void this.exportActiveSession();
				return true;
			},
		});

		this.addCommand({
			id: 'export-html',
			name: 'Export session to HTML',
			checkCallback: (checking: boolean) => {
				if (!this.getActiveTimelineView()) return false;
				if (checking) return true;
				void this.exportActiveSessionHTML();
				return true;
			},
		});

		this.addCommand({
			id: 'expand-all',
			name: 'Expand all turns',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				if (!view) return false;
				if (checking) return true;
				view.expandAll();
				return true;
			},
		});

		this.addCommand({
			id: 'collapse-all',
			name: 'Collapse all turns',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				if (!view) return false;
				if (checking) return true;
				view.collapseAll();
				return true;
			},
		});

		this.addCommand({
			id: 'expand-all-blocks',
			name: 'Expand all blocks (tools, thinking, summary)',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				if (!view) return false;
				if (checking) return true;
				view.expandAllBlocks();
				return true;
			},
		});

		this.addCommand({
			id: 'collapse-all-blocks',
			name: 'Collapse all blocks (tools, thinking, summary)',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				if (!view) return false;
				if (checking) return true;
				view.collapseAllBlocks();
				return true;
			},
		});

		this.addCommand({
			id: 'refresh-session',
			name: 'Refresh session',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				if (!view) return false;
				if (checking) return true;
				void view.reloadSession();
				return true;
			},
		});

		this.addCommand({
			id: 'toggle-live-watch',
			name: 'Toggle live watch',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				if (!view) return false;
				if (checking) return true;
				view.toggleWatch();
				return true;
			},
		});

		this.addCommand({
			id: 'search-in-session',
			name: 'Search in session',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				const session = view?.getSession();
				if (!view || !session?.rawPath) return false;
				if (checking) return true;
				void this.revealSearchView('in-session');
				return true;
			},
		});

		this.addCommand({
			id: 'copy-resume',
			name: 'Copy resume to clipboard',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				const id = view?.getSession()?.metadata.id;
				if (!id) return false;
				if (checking) return true;
				void navigator.clipboard.writeText(`claude --resume ${id}`);
				new Notice('Copied resume command');
				return true;
			},
		});

		this.addCommand({
			id: 'distill-session',
			name: 'Distill session to note',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				const session = view?.getSession();
				if (!session) return false;
				if (checking) return true;
				void this.distillActiveSession();
				return true;
			},
		});

		this.addCommand({
			id: 'merge-distill-clipboard',
			name: 'Merge /distill output from clipboard',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveTimelineView();
				const session = view?.getSession();
				if (!session) return false;
				if (checking) return true;
				void this.mergeDistillFromClipboard();
				return true;
			},
		});

		this.addCommand({
			id: 'install-bases-templates',
			name: 'Install bases dashboard templates',
			callback: async () => {
				const result = await installBasesTemplates(
					this.app,
					this.settings.basesFolder
				);
				if (result.installed.length > 0) {
					new Notice(`Installed: ${result.installed.join(', ')}`);
				}
				if (result.skipped.length > 0) {
					new Notice(`Skipped (already exist): ${result.skipped.join(', ')}`);
				}
				if (result.failed.length > 0) {
					new Notice(`Failed: ${result.failed.map(f => f.name).join(', ')}`);
				}
			},
		});

		// Protocol handler: obsidian://claude-sessions?session=/path/to/session.jsonl&turn=7
		this.registerObsidianProtocolHandler('claude-sessions', async (params) => {
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
			const content = await readFileContent(filePath);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format.');
				return;
			}
			const session = parser.parse(content, filePath);
			await resolveSubAgentSessions(session, readFileContent, listDirectoryFiles);
			await this.openSession(session, turnIndex);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}

	onunload(): void {
		// Stop all active file watchers before plugin unloads
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
		for (const leaf of leaves) {
			if (leaf.view instanceof TimelineView) {
				leaf.view.stopWatching();
			}
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async openSession(session: Session, turnIndex?: number, highlightQuery?: string, matchContext?: string): Promise<void> {
		// Reuse existing tab if this session is already open
		let leaf: WorkspaceLeaf | undefined;
		if (session.rawPath) {
			for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE)) {
				if (l.view instanceof TimelineView && l.view.getSession()?.rawPath === session.rawPath) {
					leaf = l;
					break;
				}
			}
		}

		if (leaf) {
			void this.app.workspace.revealLeaf(leaf);
		} else {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_TIMELINE,
				active: true,
			});
		}

		const view = leaf.view;
		if (view instanceof TimelineView) {
			view.loadSession(session);
			if (turnIndex !== undefined) {
				requestAnimationFrame(() => {
					view.scrollToTurn(turnIndex);
					if (highlightQuery) {
						view.navigateToMatch(turnIndex, highlightQuery, matchContext);
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
		void this.app.workspace.revealLeaf(leaf);
		const view = leaf.view as SearchView;
		view.setMode(mode);
		return view;
	}

	updateTimelineViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof TimelineView) {
				view.updateSettings(this.settings);
			}
		}
	}

	/** Update content width on all open timeline views without re-rendering. */
	updateTimelineWidth(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof TimelineView) {
				view.applyMaxWidth();
			}
		}
	}

	private getActiveTimelineView(): TimelineView | null {
		const leaf = this.app.workspace.getActiveViewOfType(TimelineView);
		return leaf;
	}

	private async exportActiveSessionHTML(): Promise<void> {
		const view = this.getActiveTimelineView();
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
		const view = this.getActiveTimelineView();
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
			const mdPath = await exportToMarkdown(this.app, session, this.settings);
			new Notice(`Exported to ${mdPath}`, 5000);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Export failed: ${msg}`);
		}
	}

	private async distillActiveSession(): Promise<void> {
		const view = this.getActiveTimelineView();
		const session = view?.getSession();
		if (!session) {
			new Notice('No active session to distill.');
			return;
		}

		try {
			const result = await distillSession(this.app, session, this.settings.distillFolder);
			if (!result.success) {
				new Notice(`Distill failed: ${result.error ?? 'Unknown error'}`);
				return;
			}
			if (!result.updated) {
				new Notice(`Created: ${result.notePath}`);
			} else {
				new Notice(`Updated: ${result.notePath}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Distill failed: ${msg}`);
		}
	}

	private async mergeDistillFromClipboard(): Promise<void> {
		const view = this.getActiveTimelineView();
		const session = view?.getSession();
		if (!session) {
			new Notice('No active session.');
			return;
		}

		try {
			const clipboardText = await navigator.clipboard.readText();
			if (!clipboardText.trim()) {
				new Notice('Clipboard is empty.');
				return;
			}

			const result = await mergeWithClipboardContent(
				this.app,
				session,
				clipboardText,
				this.settings.distillFolder
			);

			if (!result.success) {
				new Notice(`Merge failed: ${result.error ?? 'Unknown error'}`);
				return;
			}
			if (!result.updated) {
				new Notice(`Created with merged content: ${result.notePath}`);
			} else {
				new Notice(`Merged into: ${result.notePath}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Merge failed: ${msg}`);
		}
	}
}
