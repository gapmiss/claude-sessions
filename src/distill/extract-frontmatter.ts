/**
 * Layer 0 extraction: Session → DistilledFrontmatter
 * Zero LLM cost — pure structural extraction from parsed session data.
 */

import { Session, Turn, ToolUseBlock } from '../types';
import { DistilledFrontmatter, DISTILL_SCHEMA_VERSION } from './types';
import { basename } from '../utils/path-utils';

/** Tools that operate on file paths. */
const FILE_PATH_TOOLS = ['Read', 'Edit', 'Write'] as const;
const PATH_TOOLS = ['Glob', 'Grep'] as const;

/**
 * Extract frontmatter from a parsed session.
 * This is Layer 0 extraction — no LLM involvement.
 */
export function extractFrontmatter(
	session: Session,
	vaultRoot?: string
): DistilledFrontmatter {
	const { metadata, stats } = session;

	// Collect files touched and count errors
	const filesTouched = new Set<string>();
	let errorCount = 0;

	for (const turn of session.turns) {
		const result = collectFilesAndCountErrors(turn, metadata.cwd, vaultRoot, filesTouched);
		errorCount += result.errorCount;
	}

	// Build frontmatter
	const frontmatter: DistilledFrontmatter = {
		tags: ['claude-session'],
		session_id: metadata.id,
		schema_version: DISTILL_SCHEMA_VERSION,

		project: metadata.project,
		cwd: metadata.cwd,
	};

	// Optional metadata fields
	if (metadata.branch) frontmatter.branch = metadata.branch;
	if (metadata.model) frontmatter.model = metadata.model;
	if (metadata.startTime) frontmatter.start_time = metadata.startTime;

	// Timing
	if (stats.durationMs > 0) {
		frontmatter.duration_min = Math.round((stats.durationMs / 60000) * 10) / 10;
	}

	// Cost & tokens
	if (stats.costUSD > 0) {
		frontmatter.cost_usd = Math.round(stats.costUSD * 100) / 100;
	}
	if (stats.inputTokens > 0) frontmatter.input_tokens = stats.inputTokens;
	if (stats.outputTokens > 0) frontmatter.output_tokens = stats.outputTokens;
	if (stats.cacheReadTokens > 0) frontmatter.cache_read_tokens = stats.cacheReadTokens;

	// Interaction shape
	if (stats.userTurns > 0) frontmatter.user_turns = stats.userTurns;
	if (stats.assistantTurns > 0) frontmatter.assistant_turns = stats.assistantTurns;

	// Tools used (sorted alphabetically)
	const toolNames = Object.keys(stats.toolUseCounts).sort();
	if (toolNames.length > 0) frontmatter.tools_used = toolNames;

	// Files touched (as wikilinks, sorted)
	if (filesTouched.size > 0) {
		frontmatter.files_touched = Array.from(filesTouched)
			.sort()
			.map(f => `[[${f}]]`);
	}

	// Error count (details available in session timeline)
	if (errorCount > 0) {
		frontmatter.error_count = errorCount;
	}

	// Source path + Obsidian URI
	frontmatter.source_path = session.rawPath;
	frontmatter.obsidian_uri = `obsidian://claude-sessions?session=${encodeURIComponent(session.rawPath)}`;

	return frontmatter;
}

/**
 * Walk a turn's content blocks to collect file paths and count errors.
 */
function collectFilesAndCountErrors(
	turn: Turn,
	cwd: string,
	vaultRoot: string | undefined,
	filesTouched: Set<string>
): { errorCount: number } {
	let errorCount = 0;

	for (const block of turn.contentBlocks) {
		if (block.type === 'tool_use') {
			collectFilesFromToolUse(block, cwd, vaultRoot, filesTouched);
		} else if (block.type === 'tool_result' && block.isError) {
			errorCount++;
		}
	}

	return { errorCount };
}

/**
 * Extract file paths from a tool use block.
 */
function collectFilesFromToolUse(
	block: ToolUseBlock,
	cwd: string,
	vaultRoot: string | undefined,
	filesTouched: Set<string>
): void {
	const input = block.input;

	// Read, Edit, Write use file_path
	if (FILE_PATH_TOOLS.includes(block.name as typeof FILE_PATH_TOOLS[number])) {
		const filePath = input['file_path'];
		if (typeof filePath === 'string' && filePath) {
			const relative = toVaultRelativePath(filePath, cwd, vaultRoot);
			filesTouched.add(relative);
		}
	}

	// Glob, Grep use path
	if (PATH_TOOLS.includes(block.name as typeof PATH_TOOLS[number])) {
		const path = input['path'];
		if (typeof path === 'string' && path) {
			const relative = toVaultRelativePath(path, cwd, vaultRoot);
			filesTouched.add(relative);
		}
	}

	// Write tool also creates files
	if (block.name === 'Write') {
		const filePath = input['file_path'];
		if (typeof filePath === 'string' && filePath) {
			const relative = toVaultRelativePath(filePath, cwd, vaultRoot);
			filesTouched.add(relative);
		}
	}
}

/**
 * Convert an absolute path to a vault-relative path for wikilinks.
 * Falls back to basename if path is outside both vault and cwd.
 */
function toVaultRelativePath(
	absolutePath: string,
	cwd: string,
	vaultRoot: string | undefined
): string {
	// If inside vault, use vault-relative path
	if (vaultRoot && absolutePath.startsWith(vaultRoot + '/')) {
		return absolutePath.slice(vaultRoot.length + 1);
	}

	// If inside cwd, use cwd-relative path
	if (absolutePath.startsWith(cwd + '/')) {
		return absolutePath.slice(cwd.length + 1);
	}

	// Fall back to basename
	return basename(absolutePath);
}

