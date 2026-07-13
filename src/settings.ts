import { App, ConfirmationModal, Modal, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type ClaudeSessionsPlugin from './main';

const WIDTH_OPTIONS: Record<string, string> = {
	'680': 'Narrow (680px)',
	'800': 'Medium (800px)',
	'960': 'Default (960px)',
	'1200': 'Wide (1200px)',
	'0': 'Full width',
};

export class SettingsTab extends PluginSettingTab {
	plugin: ClaudeSessionsPlugin;

	constructor(app: App, plugin: ClaudeSessionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		const raw = (this.plugin.settings as unknown as Record<string, unknown>)[key];
		if (key === 'maxContentWidth') return String(raw);
		return raw;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const stored = key === 'maxContentWidth' ? parseInt(value as string, 10) : value;
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = stored;
		await this.plugin.saveSettings();

		switch (key) {
			case 'showThinkingBlocks':
			case 'showToolCalls':
			case 'showToolResults':
			case 'toolGroupThreshold':
				this.plugin.updateTimelineViews();
				break;
			case 'maxContentWidth':
				this.plugin.updateTimelineWidth();
				break;
			case 'showRateLimits':
				if (!value) {
					const { clearRateLimitCache } = await import('./utils/rate-limits');
					clearRateLimitCache();
				}
				this.plugin.updateTimelineViews();
				break;
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'list',
				heading: 'Session directories',
				emptyState: 'No session directories configured.',
				addItem: {
					name: 'Add directory',
					action: () => {
						new AddDirectoryModal(this.app, (path) => {
							this.plugin.settings.sessionDirs.push(path);
							void this.plugin.saveSettings();
							this.update();
						}).open();
					},
				},
				onDelete: (idx) => {
					const dir = this.plugin.settings.sessionDirs[idx];
					new ConfirmationModal(this.app)
						.setContent(`Remove "${dir}" from session directories?`)
						.addButton(btn => btn
							.setButtonText('Remove')
							.setWarning()
							.onClick(() => {
								this.plugin.settings.sessionDirs.splice(idx, 1);
								void this.plugin.saveSettings();
								this.update();
							}))
						.addCancelButton()
						.open();
				},
				items: this.plugin.settings.sessionDirs.map((dir) => ({
					name: dir,
					searchable: false,
				})),
			},
			{
				type: 'group',
				heading: 'Export',
				items: [
					{
						name: 'Export folder',
						desc: 'Vault folder for exported session files.',
						control: { type: 'folder', key: 'exportFolder', includeRoot: true },
					},
				],
			},
			{
				type: 'group',
				heading: 'Distill',
				items: [
					{
						name: 'Distill folder',
						desc: 'Vault folder for distilled session notes with queryable frontmatter.',
						control: { type: 'folder', key: 'distillFolder', includeRoot: true },
					},
					{
						name: 'Bases folder',
						desc: 'Vault folder for dashboard templates.',
						control: { type: 'folder', key: 'basesFolder', includeRoot: true },
					},
				],
			},
			{
				type: 'group',
				heading: 'Display',
				items: [
					{
						name: 'Show thinking blocks',
						desc: 'Display assistant thinking/reasoning blocks in session view.',
						control: { type: 'toggle', key: 'showThinkingBlocks' },
					},
					{
						name: 'Show tool calls',
						desc: 'Display tool use blocks (read, bash, etc.) in session view.',
						control: { type: 'toggle', key: 'showToolCalls' },
					},
					{
						name: 'Show tool results',
						desc: 'Display tool result output in session view.',
						control: { type: 'toggle', key: 'showToolResults' },
					},
					{
						name: 'Content width',
						desc: 'Maximum width of session content. Narrower widths improve readability.',
						control: {
							type: 'dropdown',
							key: 'maxContentWidth',
							defaultValue: '960',
							options: WIDTH_OPTIONS,
						},
					},
					{
						name: 'Tool group threshold',
						desc: 'Consecutive tool calls above this number are collapsed into a group.',
						control: {
							type: 'number',
							key: 'toolGroupThreshold',
							min: 1,
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Live watch',
				items: [
					{
						name: 'Auto-scroll on update',
						desc: 'Scroll to bottom when new content arrives during live watch.',
						control: { type: 'toggle', key: 'autoScrollOnUpdate' },
					},
					{
						name: 'Notify on pending tool',
						desc: 'Show a system notification when a live-watched session has a tool call waiting for permission.',
						control: { type: 'toggle', key: 'notifyOnPendingTool' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Beta',
				items: [
					{
						name: 'Show rate limits',
						desc: 'Display Claude account rate limit utilization in the summary hero cards. Requires network access.',
						control: { type: 'toggle', key: 'showRateLimits' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Debug',
				items: [
					{
						name: 'Debug level',
						desc: 'Control console logging verbosity for debugging.',
						control: {
							type: 'dropdown',
							key: 'debugLevel',
							defaultValue: 'warn',
							options: {
								none: 'None',
								error: 'Errors only',
								warn: 'Warnings and errors',
								info: 'Info, warnings, and errors',
								debug: 'Debug (all logs)',
							},
						},
					},
				],
			},
		];
	}
}

class AddDirectoryModal extends Modal {
	private onSubmit: (path: string) => void;

	constructor(app: App, onSubmit: (path: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.titleEl.setText('Add session directory');
		let value = '';

		new Setting(this.contentEl)
			.setName('Directory path')
			.setDesc('Path to a directory containing session files (supports ~ for home).')
			.addText(text => {
				text.setPlaceholder('~/.claude/projects');
				text.onChange(v => { value = v; });
				text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						submit();
					}
				});
			});

		const submit = () => {
			const trimmed = value.trim();
			if (trimmed) {
				this.onSubmit(trimmed);
				this.close();
			}
		};

		new Setting(this.contentEl)
			.addButton(btn => btn
				.setButtonText('Add')
				.setCta()
				.onClick(submit));
	}
}
