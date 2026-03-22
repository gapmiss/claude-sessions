import { App, PluginSettingTab, Setting } from 'obsidian';
import type AgentSessionsPlugin from './main';
import { PluginSettings, DEFAULT_SETTINGS } from './types';

export type { PluginSettings };
export { DEFAULT_SETTINGS };

export class SettingsTab extends PluginSettingTab {
	plugin: AgentSessionsPlugin;

	constructor(app: App, plugin: AgentSessionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setHeading()
			.setName('Session directories');

		// Session directories
		const dirsContainer = containerEl.createDiv({ cls: 'agent-sessions-dirs-list' });
		this.renderDirsList(dirsContainer);

		let addDirInput: import('obsidian').TextComponent;
		const addDir = async () => {
			const val = addDirInput.getValue().trim();
			if (val) {
				this.plugin.settings.sessionDirs.push(val);
				await this.plugin.saveSettings();
				addDirInput.setValue('');
				this.renderDirsList(dirsContainer);
			}
		};

		new Setting(containerEl)
			.setName('Add session directory')
			.setDesc('Path to a directory containing agent session files (supports ~ for home).')
			.addText(text => {
				addDirInput = text;
				text.setPlaceholder('~/.claude/projects');
				text.inputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						await addDir();
					}
				});
			})
			.addButton(btn => btn
				.setButtonText('Add')
				.setCta()
				.onClick(() => addDir()));

		new Setting(containerEl)
			.setHeading()
			.setName('Export');

		new Setting(containerEl)
			.setName('Export folder')
			.setDesc('Vault folder for exported session files.')
			.addText(text => text
				.setPlaceholder('Agent sessions')
				.setValue(this.plugin.settings.exportFolder)
				.onChange(async (value) => {
					this.plugin.settings.exportFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default export format')
			.addDropdown(dd => dd
				.addOption('markdown', 'Markdown')
				.addOption('html', 'HTML')
				.setValue(this.plugin.settings.defaultExportFormat)
				.onChange(async (value) => {
					this.plugin.settings.defaultExportFormat = value as 'markdown' | 'html';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setHeading()
			.setName('Display');

		new Setting(containerEl)
			.setName('Show thinking blocks')
			.setDesc('Display assistant thinking/reasoning blocks in replay.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showThinkingBlocks)
				.onChange(async (value) => {
					this.plugin.settings.showThinkingBlocks = value;
					await this.plugin.saveSettings();
					this.plugin.updateReplayViews();
				}));

		new Setting(containerEl)
			.setName('Show tool calls')
			.setDesc('Display tool use blocks (read, bash, etc.) in replay.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showToolCalls)
				.onChange(async (value) => {
					this.plugin.settings.showToolCalls = value;
					await this.plugin.saveSettings();
					this.plugin.updateReplayViews();
				}));

		new Setting(containerEl)
			.setName('Show tool results')
			.setDesc('Display tool result output in replay.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showToolResults)
				.onChange(async (value) => {
					this.plugin.settings.showToolResults = value;
					await this.plugin.saveSettings();
					this.plugin.updateReplayViews();
				}));

		new Setting(containerEl)
			.setHeading()
			.setName('Display');
	}

	private renderDirsList(container: HTMLElement): void {
		container.empty();
		for (let i = 0; i < this.plugin.settings.sessionDirs.length; i++) {
			const dir = this.plugin.settings.sessionDirs[i];
			const row = container.createDiv({ cls: 'agent-sessions-dir-row' });
			row.createSpan({ text: dir, cls: 'agent-sessions-dir-path' });
			const removeBtn = row.createEl('button', {
				cls: 'agent-sessions-btn agent-sessions-dir-remove',
				text: '\u00D7',
				attr: {
					'aria-label': `Remove directory ${dir}`,
					'data-tooltip-position': 'top',
				},
			});
			removeBtn.addEventListener('click', async () => {
				this.plugin.settings.sessionDirs.splice(i, 1);
				await this.plugin.saveSettings();
				this.renderDirsList(container);
			});
		}
	}
}
