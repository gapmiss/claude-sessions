/**
 * Manual YAML frontmatter serialization.
 * No library dependency — follows existing markdown-exporter.ts pattern.
 */

import { DistilledFrontmatter } from './types';

/**
 * Serialize frontmatter to YAML string (without --- delimiters).
 */
export function serializeFrontmatter(fm: DistilledFrontmatter): string {
	const lines: string[] = [];

	// Tags (block style array)
	lines.push('tags:');
	for (const tag of fm.tags) {
		lines.push(`  - ${tag}`);
	}

	// Identity
	lines.push(`session_id: ${quote(fm.session_id)}`);
	lines.push(`schema_version: ${fm.schema_version}`);

	// Project context
	lines.push('');
	lines.push(`project: ${quote(fm.project)}`);
	lines.push(`cwd: ${quote(fm.cwd)}`);
	if (fm.branch) lines.push(`branch: ${quote(fm.branch)}`);
	if (fm.model) lines.push(`model: ${quote(fm.model)}`);

	// Timing
	if (fm.start_time || fm.duration_min !== undefined) {
		lines.push('');
		if (fm.start_time) lines.push(`start_time: ${fm.start_time}`);
		if (fm.duration_min !== undefined) lines.push(`duration_min: ${fm.duration_min}`);
	}

	// Cost & tokens
	if (fm.cost_usd !== undefined || fm.input_tokens !== undefined) {
		lines.push('');
		if (fm.cost_usd !== undefined) lines.push(`cost_usd: ${fm.cost_usd}`);
		if (fm.input_tokens !== undefined) lines.push(`input_tokens: ${fm.input_tokens}`);
		if (fm.output_tokens !== undefined) lines.push(`output_tokens: ${fm.output_tokens}`);
		if (fm.cache_read_tokens !== undefined) lines.push(`cache_read_tokens: ${fm.cache_read_tokens}`);
	}

	// Interaction shape
	if (fm.user_turns !== undefined || fm.assistant_turns !== undefined) {
		lines.push('');
		if (fm.user_turns !== undefined) lines.push(`user_turns: ${fm.user_turns}`);
		if (fm.assistant_turns !== undefined) lines.push(`assistant_turns: ${fm.assistant_turns}`);
	}

	// Tools used (flow style for compactness)
	if (fm.tools_used && fm.tools_used.length > 0) {
		lines.push(`tools_used: [${fm.tools_used.join(', ')}]`);
	}

	// Files touched (block style — can be long)
	if (fm.files_touched && fm.files_touched.length > 0) {
		lines.push('files_touched:');
		for (const file of fm.files_touched) {
			lines.push(`  - ${quote(file)}`);
		}
	}

	// Error count (just the number — details in session timeline)
	if (fm.error_count !== undefined && fm.error_count > 0) {
		lines.push(`error_count: ${fm.error_count}`);
	}

	// Session type (LLM-only field)
	if (fm.session_type && fm.session_type.length > 0) {
		lines.push('session_type:');
		for (const type of fm.session_type) {
			lines.push(`  - ${type}`);
		}
	}

	// Source path + Obsidian URI
	if (fm.source_path) {
		lines.push('');
		lines.push(`source_path: ${quote(fm.source_path)}`);
	}
	if (fm.obsidian_uri) {
		lines.push(`obsidian_uri: ${quote(fm.obsidian_uri)}`);
	}

	return lines.join('\n');
}

/**
 * Quote a string for YAML if it contains special characters.
 * Uses double quotes with escaping for special chars.
 */
function quote(value: string): string {
	// Check if quoting is needed
	const needsQuote =
		value === '' ||
		value.startsWith(' ') ||
		value.endsWith(' ') ||
		/[:#[\]{}|>&*!?'"\n\r\t\\]/.test(value) ||
		/^[\d.+-]/.test(value) ||  // Could be parsed as number
		['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase());

	if (!needsQuote) {
		return value;
	}

	// Escape special characters and wrap in double quotes
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');

	return `"${escaped}"`;
}

/**
 * Wrap content with YAML frontmatter delimiters.
 */
export function wrapFrontmatter(yaml: string): string {
	return `---\n${yaml}\n---`;
}
