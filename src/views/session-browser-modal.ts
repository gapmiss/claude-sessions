import { App, FuzzySuggestModal, FuzzyMatch, Notice, Platform } from 'obsidian';
import type AgentSessionsPlugin from '../main';
import { SessionListEntry } from '../types';
import { expandHome, extractProjectName, basename } from '../utils/path-utils';
import { listDirectory, listSubdirectories, readFileContent } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';

/**
 * Scan configured session directories and return entries.
 * Must be called before opening the modal so items are available synchronously.
 */
export async function scanSessionDirs(plugin: AgentSessionsPlugin): Promise<SessionListEntry[]> {
	if (Platform.isMobile) {
		new Notice('On mobile, session browsing is limited to vault files.');
		return [];
	}

	const entries: SessionListEntry[] = [];

	for (const dir of plugin.settings.sessionDirs) {
		const expanded = expandHome(dir);
		try {
			const subdirs = await listSubdirectories(expanded);
			for (const subdir of subdirs) {
				const files = await listDirectory(subdir);
				for (const file of files) {
					entries.push({
						id: basename(file).replace(/\.\w+$/, ''),
						project: extractProjectName(subdir),
						format: guessFormat(file),
						date: getFileDate(file),
						path: file,
					});
				}
			}

			const rootFiles = await listDirectory(expanded);
			for (const file of rootFiles) {
				entries.push({
					id: basename(file).replace(/\.\w+$/, ''),
					project: extractProjectName(expanded),
					format: guessFormat(file),
					date: getFileDate(file),
					path: file,
				});
			}
		} catch {
			// Directory doesn't exist or isn't readable
		}
	}

	entries.sort((a, b) => {
		if (!a.date && !b.date) return 0;
		if (!a.date) return 1;
		if (!b.date) return -1;
		return b.date.localeCompare(a.date);
	});

	return entries;
}

export class SessionBrowserModal extends FuzzySuggestModal<SessionListEntry> {
	private plugin: AgentSessionsPlugin;
	private entries: SessionListEntry[];

	constructor(app: App, plugin: AgentSessionsPlugin, entries: SessionListEntry[]) {
		super(app);
		this.plugin = plugin;
		this.entries = entries;
		this.setPlaceholder('Search sessions...');
	}

	getItems(): SessionListEntry[] {
		return this.entries;
	}

	getItemText(item: SessionListEntry): string {
		const parts = [item.project];
		if (item.date) parts.push(item.date);
		parts.push(`[${item.format}]`);
		return parts.join(' \u2014 ');
	}

	renderSuggestion(item: FuzzyMatch<SessionListEntry>, el: HTMLElement): void {
		super.renderSuggestion(item, el);
		const entry = item.item;
		const badge = el.createSpan({
			cls: 'agent-sessions-suggestion-format',
			text: entry.format,
		});
		el.appendChild(badge);

		if (entry.date) {
			const dateEl = el.createSpan({
				cls: 'agent-sessions-suggestion-date',
				text: entry.date,
			});
			el.appendChild(dateEl);
		}
	}

	async onChooseItem(item: SessionListEntry): Promise<void> {
		try {
			new Notice('Loading session...');
			const content = await readFileContent(item.path);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format.');
				return;
			}

			const session = parser.parse(content, item.path);
			await this.plugin.openSession(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}
}

function guessFormat(filePath: string): 'claude' | 'cursor' | 'codex' {
	if (filePath.includes('.claude') || filePath.endsWith('.jsonl')) return 'claude';
	if (filePath.includes('cursor')) return 'cursor';
	if (filePath.includes('codex')) return 'codex';
	return 'claude';
}

function getFileDate(filePath: string): string | undefined {
	if (!Platform.isDesktop) return undefined;
	try {
		const fs = require('fs') as typeof import('fs');
		const stat = fs.statSync(filePath);
		return stat.mtime.toISOString().split('T')[0];
	} catch {
		return undefined;
	}
}
