/**
 * Distill orchestrator — the main pipeline for session distillation.
 * Pipeline: extract frontmatter → find existing → merge → build note → write
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { Session } from '../types';
import { DistillOptions } from './types';
import { extractFrontmatter } from './extract-frontmatter';
import { buildNoteName, buildLayer0Note, mergeNoteContent } from './build-note';
import { findExistingNote, readExistingNote } from './find-existing';

/**
 * Result of a distill operation.
 */
export interface DistillResult {
	success: boolean;
	/** Path to the created/updated note in the vault. */
	notePath?: string;
	/** Note content (only populated in dry-run mode). */
	content?: string;
	/** Whether an existing note was updated vs created fresh. */
	updated: boolean;
	/** Error message if success is false. */
	error?: string;
}

/**
 * Distill a session to a structured note in the vault.
 * This is Layer 0 distillation — zero LLM cost, pure structural extraction.
 */
export async function distillSession(
	app: App,
	session: Session,
	distillFolder: string,
	options: DistillOptions = {}
): Promise<DistillResult> {
	try {
		// Get vault root for path conversion
		const adapter = app.vault.adapter as unknown as { basePath?: string };
		const vaultRoot = adapter.basePath;

		// Step 1: Extract frontmatter
		const frontmatter = extractFrontmatter(session, vaultRoot);

		// Step 2: Check for existing note
		const existingPath = findExistingNote(app, distillFolder, frontmatter.session_id);

		let noteContent: string;
		let updated = false;

		if (existingPath && !options.force) {
			// Step 3a: Merge with existing note
			const existingContent = await readExistingNote(app, existingPath);
			if (existingContent) {
				const newContent = buildLayer0Note(frontmatter);
				noteContent = mergeNoteContent(newContent, existingContent);
				updated = true;
			} else {
				// Existing file couldn't be read — create fresh
				noteContent = buildLayer0Note(frontmatter);
			}
		} else {
			// Step 3b: Build fresh note
			noteContent = buildLayer0Note(frontmatter);
		}

		// Step 4: Dry run check
		if (options.dryRun) {
			return {
				success: true,
				content: noteContent,
				updated,
			};
		}

		// Step 5: Ensure folder exists
		await ensureFolder(app, distillFolder);

		// Step 6: Write note
		const noteName = buildNoteName(frontmatter);
		const notePath = normalizePath(`${distillFolder}/${noteName}`);

		const existingFile = app.vault.getAbstractFileByPath(notePath);
		if (existingFile instanceof TFile) {
			await app.vault.modify(existingFile, noteContent);
			updated = true;
		} else {
			await app.vault.create(notePath, noteContent);
		}

		return {
			success: true,
			notePath,
			updated,
		};
	} catch (err) {
		return {
			success: false,
			updated: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Batch distill multiple sessions.
 * Skips sessions that already have distilled notes (unless force=true).
 */
export async function batchDistillSessions(
	app: App,
	sessions: Session[],
	distillFolder: string,
	options: DistillOptions = {},
	onProgress?: (done: number, total: number, current: string) => void
): Promise<BatchDistillResult> {
	const results: DistillResult[] = [];
	let created = 0;
	let updated = 0;
	let skipped = 0;
	let failed = 0;

	for (let i = 0; i < sessions.length; i++) {
		const session = sessions[i];
		onProgress?.(i, sessions.length, session.metadata.project);

		// Check if already distilled
		const existing = findExistingNote(app, distillFolder, session.metadata.id);
		if (existing && !options.force) {
			skipped++;
			continue;
		}

		const result = await distillSession(app, session, distillFolder, options);
		results.push(result);

		if (result.success) {
			if (result.updated) {
				updated++;
			} else {
				created++;
			}
		} else {
			failed++;
		}
	}

	onProgress?.(sessions.length, sessions.length, 'Done');

	return {
		results,
		created,
		updated,
		skipped,
		failed,
		total: sessions.length,
	};
}

export interface BatchDistillResult {
	results: DistillResult[];
	created: number;
	updated: number;
	skipped: number;
	failed: number;
	total: number;
}

/**
 * Merge LLM-distilled content (from clipboard) with Layer 0 extraction from active session.
 *
 * This is the recommended workflow:
 * 1. User runs /distill in Claude Code → output to stdout
 * 2. User copies the output
 * 3. User opens session in timeline view
 * 4. User runs "Merge /distill output from clipboard" command
 * 5. Plugin merges clipboard narrative with active session's exact metadata
 */
export async function mergeWithClipboardContent(
	app: App,
	session: Session,
	clipboardContent: string,
	distillFolder: string
): Promise<DistillResult> {
	try {
		// Validate clipboard content looks like a distilled note
		if (!clipboardContent.includes('---') || !clipboardContent.includes('## Summary')) {
			return {
				success: false,
				updated: false,
				error: 'Clipboard does not contain a valid /distill output (missing frontmatter or ## Summary)',
			};
		}

		// Get vault root for path conversion
		const adapter = app.vault.adapter as unknown as { basePath?: string };
		const vaultRoot = adapter.basePath;

		// Extract Layer 0 frontmatter from the active session (exact values)
		const layer0Frontmatter = extractFrontmatter(session, vaultRoot);
		const layer0Note = buildLayer0Note(layer0Frontmatter);

		// Merge: Layer 0 numerics + LLM narrative
		const mergedContent = mergeNoteContent(layer0Note, clipboardContent);

		// Ensure folder exists
		await ensureFolder(app, distillFolder);

		// Write merged note using Layer 0's session_id for naming
		const noteName = buildNoteName(layer0Frontmatter);
		const notePath = normalizePath(`${distillFolder}/${noteName}`);

		const existingFile = app.vault.getAbstractFileByPath(notePath);
		if (existingFile instanceof TFile) {
			await app.vault.modify(existingFile, mergedContent);
		} else {
			await app.vault.create(notePath, mergedContent);
		}

		return {
			success: true,
			notePath,
			updated: existingFile instanceof TFile,
		};
	} catch (err) {
		return {
			success: false,
			updated: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Ensure a folder path exists, creating intermediate folders as needed.
 */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	const existing = app.vault.getAbstractFileByPath(normalized);

	if (existing) {
		if (!(existing instanceof TFolder)) {
			throw new Error(`${folderPath} exists but is not a folder`);
		}
		return;
	}

	// Create folder (and parents if needed)
	await app.vault.createFolder(normalized);
}
