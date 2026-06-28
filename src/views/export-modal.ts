import { Modal, Setting } from 'obsidian';
import type { PluginSettings } from '../types';

export type ExportFormat = 'html' | 'markdown';

export interface ExportOptions {
	format: ExportFormat;
	includeSummary: boolean;
	includeSystemEvents: boolean;
}

export class ExportModal extends Modal {
	private settings: PluginSettings;
	private format: ExportFormat;
	private onConfirm: (options: ExportOptions) => void | Promise<void>;
	private saveSettings: () => Promise<void>;

	constructor(
		app: InstanceType<typeof import('obsidian').App>,
		settings: PluginSettings,
		format: ExportFormat,
		saveSettings: () => Promise<void>,
		onConfirm: (options: ExportOptions) => void | Promise<void>,
	) {
		super(app);
		this.settings = settings;
		this.format = format;
		this.saveSettings = saveSettings;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass('claude-sessions-export-modal');

		const formatLabel = this.format === 'html' ? 'HTML' : 'Markdown';
		contentEl.createEl('h3', { text: `Export to ${formatLabel}` });

		new Setting(contentEl)
			.setName('Include summary')
			.setDesc('Session stats, token usage, tool usage, and metadata.')
			.addToggle(toggle => toggle
				.setValue(this.settings.exportIncludeSummary)
				.onChange(async (value) => {
					this.settings.exportIncludeSummary = value;
					await this.saveSettings();
				}));

		new Setting(contentEl)
			.setName('Include system events')
			.setDesc('Hooks, skills, and task reminders.')
			.addToggle(toggle => toggle
				.setValue(this.settings.exportIncludeSystemEvents)
				.onChange(async (value) => {
					this.settings.exportIncludeSystemEvents = value;
					await this.saveSettings();
				}));

		const btnRow = contentEl.createDiv({ cls: 'claude-sessions-export-modal-buttons' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const exportBtn = btnRow.createEl('button', {
			text: `Export ${formatLabel}`,
			cls: 'mod-cta',
		});
		exportBtn.addEventListener('click', () => {
			this.close();
			void this.onConfirm({
				format: this.format,
				includeSummary: this.settings.exportIncludeSummary,
				includeSystemEvents: this.settings.exportIncludeSystemEvents,
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
