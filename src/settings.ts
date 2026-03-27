import { App, PluginSettingTab, Setting } from 'obsidian';
import type ClaudeSessionsPlugin from './main';
import { PluginSettings, DEFAULT_SETTINGS } from './types';

export class SettingsTab extends PluginSettingTab {
	plugin: ClaudeSessionsPlugin;

	constructor(app: App, plugin: ClaudeSessionsPlugin) {
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
		const dirsContainer = containerEl.createDiv({ cls: 'claude-sessions-dirs-list' });
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
			.setDesc('Path to a directory containing Claude Code session files (supports ~ for home).')
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
				.setPlaceholder('Claude sessions')
				.setValue(this.plugin.settings.exportFolder)
				.onChange(async (value) => {
					this.plugin.settings.exportFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setHeading()
			.setName('Display');

		new Setting(containerEl)
			.setName('Show thinking blocks')
			.setDesc('Display assistant thinking/reasoning blocks in session view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showThinkingBlocks)
				.onChange(async (value) => {
					this.plugin.settings.showThinkingBlocks = value;
					await this.plugin.saveSettings();
					this.plugin.updateTimelineViews();
				}));

		new Setting(containerEl)
			.setName('Show tool calls')
			.setDesc('Display tool use blocks (read, bash, etc.) in session view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showToolCalls)
				.onChange(async (value) => {
					this.plugin.settings.showToolCalls = value;
					await this.plugin.saveSettings();
					this.plugin.updateTimelineViews();
				}));

		new Setting(containerEl)
			.setName('Show tool results')
			.setDesc('Display tool result output in session view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showToolResults)
				.onChange(async (value) => {
					this.plugin.settings.showToolResults = value;
					await this.plugin.saveSettings();
					this.plugin.updateTimelineViews();
				}));

		new Setting(containerEl)
			.setName('Show hook icons')
			.setDesc('Display hook indicator icons on tool calls that triggered hooks.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showHookIcons)
				.onChange(async (value) => {
					this.plugin.settings.showHookIcons = value;
					await this.plugin.saveSettings();
					this.plugin.updateTimelineViews();
				}));

		new Setting(containerEl)
			.setName('Tool group threshold')
			.setDesc('Consecutive tool calls above this number are collapsed into a group.')
			.addText(text => text
				.setValue(String(this.plugin.settings.toolGroupThreshold))
				.onChange(async (value) => {
					const n = parseInt(value, 10);
					if (!isNaN(n) && n >= 1) {
						this.plugin.settings.toolGroupThreshold = n;
						await this.plugin.saveSettings();
						this.plugin.updateTimelineViews();
					}
				}));

		new Setting(containerEl)
			.setHeading()
			.setName('Live watch');

		new Setting(containerEl)
			.setName('Auto-scroll on update')
			.setDesc('Scroll to bottom when new content arrives during live watch.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoScrollOnUpdate)
				.onChange(async (value) => {
					this.plugin.settings.autoScrollOnUpdate = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderDirsList(container: HTMLElement): void {
		container.empty();
		for (let i = 0; i < this.plugin.settings.sessionDirs.length; i++) {
			const dir = this.plugin.settings.sessionDirs[i];
			const row = container.createDiv({ cls: 'claude-sessions-dir-row' });
			row.createSpan({ text: dir, cls: 'claude-sessions-dir-path' });
			const removeBtn = row.createEl('button', {
				cls: 'claude-sessions-btn claude-sessions-dir-remove',
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
