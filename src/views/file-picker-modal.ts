import { Modal, Notice, Setting, Platform } from 'obsidian';
import type ClaudeSessionsPlugin from '../main';
import { expandHome } from '../utils/path-utils';
import { readFileContent } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';
import { resolveSubAgentSessions } from '../parsers/claude-subagent';

export class FilePickerModal extends Modal {
	private plugin: ClaudeSessionsPlugin;

	constructor(app: InstanceType<typeof import('obsidian').App>, plugin: ClaudeSessionsPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass('claude-sessions-file-picker-modal');
		contentEl.createEl('h3', { text: 'Import session file' });

		let filePath = '';

		// Drop zone / file picker
		if (!Platform.isMobile) {
			const dropZone = contentEl.createDiv({ cls: 'claude-sessions-drop-zone' });
			dropZone.setAttribute('tabindex', '0');
			dropZone.setAttribute('role', 'button');
			dropZone.setAttribute('aria-label', 'Drop or click to select a session file');
			dropZone.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					dropZone.click();
				}
			});
			const fileInput = dropZone.createEl('input', { type: 'file' });
			fileInput.accept = '.jsonl,.json';
			fileInput.addClass('claude-sessions-drop-zone-input');
			fileInput.addClass('claude-sessions-hidden');

			const label = dropZone.createDiv({ cls: 'claude-sessions-drop-zone-label' });
			label.createSpan({ text: 'Drop a session file here, or ' });
			const browseLink = label.createEl('button', {
				text: 'Browse',
				cls: 'claude-sessions-drop-zone-browse',
				attr: { 'aria-label': 'Browse for session file', type: 'button' },
			});
			label.createSpan({ text: '.' });

			const hint = dropZone.createDiv({
				text: '.jsonl or .json',
				cls: 'claude-sessions-drop-zone-hint',
			});

			// Click to browse
			browseLink.addEventListener('click', (e) => {
				e.stopPropagation();
				fileInput.click();
			});
			dropZone.addEventListener('click', () => {
				fileInput.click();
			});

			fileInput.addEventListener('change', () => {
				const file = fileInput.files?.[0];
				if (file) this.importFromFile(file);
			});

			// Drag events
			dropZone.addEventListener('dragover', (e) => {
				e.preventDefault();
				e.stopPropagation();
				dropZone.addClass('drag-over');
			});
			dropZone.addEventListener('dragleave', (e) => {
				e.preventDefault();
				e.stopPropagation();
				dropZone.removeClass('drag-over');
			});
			dropZone.addEventListener('drop', (e) => {
				e.preventDefault();
				e.stopPropagation();
				dropZone.removeClass('drag-over');
				const file = e.dataTransfer?.files[0];
				if (file) this.importFromFile(file);
			});
		}

		// Divider with "or enter path"
		if (!Platform.isMobile) {
			const divider = contentEl.createDiv({ cls: 'claude-sessions-drop-zone-divider' });
			divider.createSpan({ text: 'or enter a path' });
		}

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
				cls: 'claude-sessions-mobile-notice',
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async importFromFile(file: File): Promise<void> {
		// On Electron, File objects have a `path` property with the absolute filesystem path
		const electronPath = (file as File & { path?: string }).path;
		if (electronPath) {
			return this.importFile(electronPath);
		}

		// Fallback: read content directly (e.g. mobile or path unavailable).
		// Try to resolve the full path from session metadata + configured dirs.
		try {
			new Notice('Reading file...');
			const content = await file.text();

			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format. Ensure this is a valid session file.');
				return;
			}

			// Attempt to find the full path by searching session directories
			const fullPath = await this.resolveSessionPath(file.name) ?? file.name;
			const session = parser.parse(content, fullPath);
			await resolveSubAgentSessions(session, readFileContent);
			new Notice(`Loaded session with ${session.turns.length} turns.`);
			this.close();
			await this.plugin.openSession(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Import failed: ${msg}`);
		}
	}

	/** Search configured session directories for a file by name. */
	private async resolveSessionPath(fileName: string): Promise<string | null> {
		if (!Platform.isDesktop) return null;
		const fs = require('fs') as typeof import('fs');
		const path = require('path') as typeof import('path');
		// Strip directory components to prevent path traversal
		const safeName = path.basename(fileName);
		for (const dir of this.plugin.settings.sessionDirs) {
			const expanded = expandHome(dir);
			try {
				const subdirs = fs.readdirSync(expanded, { withFileTypes: true });
				for (const entry of subdirs) {
					if (entry.isDirectory()) {
						const candidate = path.join(expanded, entry.name, safeName);
						if (fs.existsSync(candidate)) return candidate;
					}
				}
				// Also check root of session dir
				const rootCandidate = path.join(expanded, safeName);
				if (fs.existsSync(rootCandidate)) return rootCandidate;
			} catch { /* skip inaccessible dirs */ }
		}
		return null;
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
			await resolveSubAgentSessions(session, readFileContent);
			new Notice(`Loaded session with ${session.turns.length} turns.`);
			this.close();
			await this.plugin.openSession(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Import failed: ${msg}`);
		}
	}
}
