import { Modal, Notice, Setting, Platform } from 'obsidian';
import type AgentSessionsPlugin from '../main';
import { expandHome } from '../utils/path-utils';
import { readFileContent } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';

export class FilePickerModal extends Modal {
	private plugin: AgentSessionsPlugin;

	constructor(app: InstanceType<typeof import('obsidian').App>, plugin: AgentSessionsPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'Import session file' });

		let filePath = '';

		new Setting(contentEl)
			.setName('File path')
			.setDesc('Path to a .jsonl session file (supports ~ for home directory).')
			.addText(text => {
				text.setPlaceholder('~/.claude/projects/myproject/session.jsonl');
				text.onChange(value => { filePath = value; });
				text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						this.importFile(filePath);
					}
				});
				// Focus the input
				setTimeout(() => text.inputEl.focus(), 50);
			});

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Import')
				.setCta()
				.onClick(() => this.importFile(filePath)));

		if (Platform.isMobile) {
			contentEl.createEl('p', {
				text: 'On mobile, copy session files into your vault and open them from there.',
				cls: 'agent-sessions-mobile-notice',
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async importFile(rawPath: string): Promise<void> {
		const trimmed = rawPath.trim();
		if (!trimmed) {
			new Notice('Please enter a file path.');
			return;
		}

		const expanded = expandHome(trimmed);

		try {
			new Notice('Reading file...');
			const content = await readFileContent(expanded);

			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format. Ensure this is a valid session file.');
				return;
			}

			const session = parser.parse(content, expanded);
			new Notice(`Loaded session with ${session.turns.length} turns.`);
			this.close();
			await this.plugin.openSession(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Import failed: ${msg}`);
		}
	}
}
