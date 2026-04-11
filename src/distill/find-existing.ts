/**
 * Find existing distilled note by session_id using Obsidian's metadataCache.
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';

/**
 * Find an existing distilled note matching the given session_id.
 * Uses metadataCache for instant lookup without file I/O.
 *
 * @param app Obsidian App instance
 * @param distillFolder Path to the distill folder (e.g., 'Claude sessions/distilled')
 * @param sessionId The session_id to search for
 * @returns Path to existing note, or null if not found
 */
export function findExistingNote(
	app: App,
	distillFolder: string,
	sessionId: string
): string | null {
	const folder = app.vault.getAbstractFileByPath(normalizePath(distillFolder));
	if (!folder || !(folder instanceof TFolder)) {
		return null;
	}

	// Walk all markdown files in the distill folder
	for (const file of folder.children) {
		if (!(file instanceof TFile) || file.extension !== 'md') {
			continue;
		}

		// Get cached frontmatter
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;

		if (frontmatter && frontmatter['session_id'] === sessionId) {
			return file.path;
		}
	}

	return null;
}

/**
 * Get all session_ids that have already been distilled.
 * Useful for batch processing to skip already-processed sessions.
 */
export function getDistilledSessionIds(
	app: App,
	distillFolder: string
): Set<string> {
	const ids = new Set<string>();
	const folder = app.vault.getAbstractFileByPath(normalizePath(distillFolder));

	if (!folder || !(folder instanceof TFolder)) {
		return ids;
	}

	for (const file of folder.children) {
		if (!(file instanceof TFile) || file.extension !== 'md') {
			continue;
		}

		const cache = app.metadataCache.getFileCache(file);
		const sessionId = cache?.frontmatter?.['session_id'] as unknown;

		if (typeof sessionId === 'string') {
			ids.add(sessionId);
		}
	}

	return ids;
}

/**
 * Read existing note content for merge operations.
 */
export async function readExistingNote(
	app: App,
	path: string
): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		return null;
	}
	return app.vault.read(file);
}
