import { App, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type ClaudeSessionsPlugin from './main';
import { FolderSuggest } from './utils/folder-suggest';

const WIDTH_PRESETS: { label: string; value: number }[] = [
	{ label: 'Narrow (680px)', value: 680 },
	{ label: 'Medium (800px)', value: 800 },
	{ label: 'Default (960px)', value: 960 },
	{ label: 'Wide (1200px)', value: 1200 },
	{ label: 'Full width', value: 0 },
];

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
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Claude Code" is a proper noun
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
			.addSearch(search => {
				search
					.setPlaceholder('Claude sessions')
					.setValue(this.plugin.settings.exportFolder)
					.onChange(async (value) => {
						this.plugin.settings.exportFolder = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, search.inputEl);
			});

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
			.setName('Content width')
			.setDesc('Maximum width of session content. Narrower widths improve readability.')
			.addDropdown(dropdown => {
				for (const preset of WIDTH_PRESETS) {
					dropdown.addOption(String(preset.value), preset.label);
				}
				dropdown.setValue(String(this.plugin.settings.maxContentWidth));
				dropdown.onChange(async (value) => {
					this.plugin.settings.maxContentWidth = parseInt(value, 10);
					await this.plugin.saveSettings();
					this.plugin.updateTimelineWidth();
				});
			});

		new Setting(containerEl)
			.setName('Pin summary dashboard')
			.setDesc('Always pin the session stats bar to the top of every session view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pinSummaryDashboard)
				.onChange(async (value) => {
					this.plugin.settings.pinSummaryDashboard = value;
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

		new Setting(containerEl)
			.setName('Notify on pending tool')
			.setDesc('Show a system notification when a live-watched session has a tool call waiting for permission.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.notifyOnPendingTool)
				.onChange(async (value) => {
					this.plugin.settings.notifyOnPendingTool = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setHeading()
			.setName('Debug');

		new Setting(containerEl)
			.setName('Debug level')
			.setDesc('Control console logging verbosity for debugging.')
			.addDropdown(dropdown => dropdown
				.addOption('none', 'None')
				.addOption('error', 'Errors only')
				.addOption('warn', 'Warnings and errors')
				.addOption('info', 'Info, warnings, and errors')
				.addOption('debug', 'Debug (all logs)')
				.setValue(this.plugin.settings.debugLevel)
				.onChange(async (value) => {
					this.plugin.settings.debugLevel = value as 'none' | 'error' | 'warn' | 'info' | 'debug';
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
				cls: 'claude-sessions-dir-remove clickable-icon',
				attr: {
					'aria-label': `Remove directory ${dir}`,
					'data-tooltip-position': 'top',
				},
			});
			setIcon(removeBtn, 'trash-2');
			removeBtn.addEventListener('click', async () => {
				this.plugin.settings.sessionDirs.splice(i, 1);
				await this.plugin.saveSettings();
				this.renderDirsList(container);
			});
		}
	}
}
