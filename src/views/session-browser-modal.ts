import { App, SuggestModal, Notice, Platform } from 'obsidian';
import type ClaudeSessionsPlugin from '../main';
import { SessionListEntry } from '../types';
import { expandHome, extractProjectName, basename, shortenPath, projectFromCwd } from '../utils/path-utils';
import { listDirectory, listSubdirectories, readFileContent, extractQuickMetadataAsync } from '../utils/streaming-reader';
import { detectParser } from '../parsers/detect';
import { resolveSubAgentSessions } from '../parsers/claude-subagent';

/**
 * Scan configured session directories and return entries.
 * Uses a persistent cache — only new/modified files are re-read.
 * Must be called before opening the modal so items are available synchronously.
 */
export async function scanSessionDirs(plugin: ClaudeSessionsPlugin): Promise<{ entries: SessionListEntry[]; total: number; updated: number }> {
	if (Platform.isMobile) {
		new Notice('On mobile, session browsing is limited to vault files.');
		return { entries: [], total: 0, updated: 0 };
	}

	const fs = require('fs') as typeof import('fs');
	const index = plugin.sessionIndex;
	index.load();

	const entries: SessionListEntry[] = [];
	const discoveredPaths = new Set<string>();
	let updated = 0;

	for (const dir of plugin.settings.sessionDirs) {
		const expanded = expandHome(dir);
		try {
			const subdirs = await listSubdirectories(expanded);
			for (const subdir of subdirs) {
				const files = await listDirectory(subdir);
				for (const file of files) {
					discoveredPaths.add(file);
					const entry = await buildEntry(file, extractProjectName(subdir), fs, index);
					if (entry) {
						if (entry._updated) updated++;
						entries.push(entry.entry);
					}
				}
			}

			const rootFiles = await listDirectory(expanded);
			for (const file of rootFiles) {
				discoveredPaths.add(file);
				const entry = await buildEntry(file, extractProjectName(expanded), fs, index);
				if (entry) {
					if (entry._updated) updated++;
					entries.push(entry.entry);
				}
			}
		} catch {
			// Directory doesn't exist or isn't readable
		}
	}

	index.prune(discoveredPaths);
	index.save();

	entries.sort((a, b) => b.mtime - a.mtime);

	return { entries, total: entries.length, updated };
}

/**
 * Build a SessionListEntry from a file path using stat + cached/async metadata extraction.
 * Returns null for unreadable files or empty sessions (no user/assistant records).
 */
async function buildEntry(
	filePath: string,
	fallbackProject: string,
	fs: typeof import('fs'),
	index: InstanceType<typeof import('../utils/session-index').SessionIndex>,
): Promise<{ entry: SessionListEntry; _updated: boolean } | null> {
	let mtime: number;
	try {
		const stat = fs.statSync(filePath);
		mtime = stat.mtimeMs;
	} catch {
		return null;
	}

	let wasUpdated = false;
	let cached = index.get(filePath, mtime);
	if (!cached) {
		const meta = await extractQuickMetadataAsync(filePath);
		cached = {
			sessionId: meta.sessionId,
			cwd: meta.cwd,
			startTime: meta.startTime,
			hasContent: meta.hasContent,
			mtime,
		};
		index.set(filePath, cached);
		wasUpdated = true;
	}

	// Filter out empty sessions
	if (!cached.hasContent) return null;

	const project = cached.cwd ? projectFromCwd(cached.cwd) : fallbackProject;
	const dateSource = cached.startTime ? new Date(cached.startTime) : new Date(mtime);
	const date = formatSessionDate(dateSource);

	return {
		entry: {
			id: cached.sessionId || basename(filePath).replace(/\.\w+$/, ''),
			project,
			format: guessFormat(filePath),
			date,
			path: filePath,
			cwd: cached.cwd,
			startTime: cached.startTime,
			mtime,
		},
		_updated: wasUpdated,
	};
}

export class SessionBrowserModal extends SuggestModal<SessionListEntry> {
	private plugin: ClaudeSessionsPlugin;
	private entries: SessionListEntry[];

	constructor(app: App, plugin: ClaudeSessionsPlugin, entries: SessionListEntry[]) {
		super(app);
		this.plugin = plugin;
		this.entries = entries;
		this.setPlaceholder('Search sessions...');
	}

	getSuggestions(query: string): SessionListEntry[] {
		if (!query) return this.entries;
		const q = query.toLowerCase();
		return this.entries.filter((e) => {
			return e.project.toLowerCase().includes(q)
				|| (e.cwd?.toLowerCase().includes(q) ?? false)
				|| e.id.toLowerCase().includes(q);
		});
	}

	renderSuggestion(item: SessionListEntry, el: HTMLElement): void {
		el.addClass('claude-sessions-suggestion-item');

		const line1 = el.createDiv({ cls: 'claude-sessions-suggestion-line1' });
		line1.createSpan({ cls: 'claude-sessions-suggestion-project', text: item.project });
		if (item.date) {
			line1.createSpan({ cls: 'claude-sessions-suggestion-date', text: item.date });
		}

		const line2 = el.createDiv({ cls: 'claude-sessions-suggestion-line2' });
		const pathText = item.cwd ? shortenPath(item.cwd) : '';
		const line2Left = pathText ? `${pathText} · ${item.id}` : item.id;
		line2.createSpan({ cls: 'claude-sessions-suggestion-path', text: line2Left });
		line2.createSpan({ cls: 'claude-sessions-suggestion-format', text: item.format });
	}

	async onChooseSuggestion(item: SessionListEntry): Promise<void> {
		try {
			new Notice('Loading session...');
			const content = await readFileContent(item.path);
			const parser = detectParser(content);
			if (!parser) {
				new Notice('Could not detect session format.');
				return;
			}

			const session = parser.parse(content, item.path);
			await resolveSubAgentSessions(session, readFileContent);
			await this.plugin.openSession(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to load session: ${msg}`);
		}
	}
}

function guessFormat(filePath: string): 'claude' {
	return 'claude';
}

/**
 * Format a date for compact display in the session browser.
 * Today: "12:03", this week: "Mon 12:03", this year: "Mar 22, 12:03", older: "Mar 22, 2025"
 */
function formatSessionDate(d: Date): string {
	const now = new Date();
	const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

	// Today
	if (d.toDateString() === now.toDateString()) {
		return time;
	}

	// Within the last 7 days
	const weekAgo = new Date(now);
	weekAgo.setDate(weekAgo.getDate() - 7);
	if (d > weekAgo) {
		const day = d.toLocaleDateString(undefined, { weekday: 'short' });
		return `${day} ${time}`;
	}

	const month = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

	// Same year
	if (d.getFullYear() === now.getFullYear()) {
		return `${month}, ${time}`;
	}

	// Older
	return `${month}, ${d.getFullYear()}`;
}
