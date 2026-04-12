/**
 * Build complete distilled note from frontmatter.
 * Layer 0 generates a Stats table; LLM-distilled notes have narrative sections.
 */

import { DistilledFrontmatter } from './types';
import { serializeFrontmatter, wrapFrontmatter } from './serialize-frontmatter';

/**
 * Generate note filename from frontmatter.
 * Format: {project}--{YYYY-MM-DD}--{short-id}.md
 */
export function buildNoteName(fm: DistilledFrontmatter): string {
	// Sanitize project name (non-alphanumeric → hyphens, collapse multiples)
	const project = fm.project
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase() || 'unknown';

	// Extract date from start_time or use 'undated'
	let dateStr = 'undated';
	if (fm.start_time) {
		const parsed = new Date(fm.start_time);
		if (!isNaN(parsed.getTime())) {
			dateStr = parsed.toISOString().slice(0, 10);  // YYYY-MM-DD
		}
	}

	// First 8 chars of session_id
	const shortId = fm.session_id.slice(0, 8);

	return `${project}--${dateStr}--${shortId}.md`;
}

/**
 * Build complete note content for Layer 0 extraction.
 * Includes frontmatter + Stats table (no narrative sections).
 */
export function buildLayer0Note(fm: DistilledFrontmatter): string {
	const parts: string[] = [];

	// Frontmatter
	parts.push(wrapFrontmatter(serializeFrontmatter(fm)));
	parts.push('');

	// Stats table
	parts.push('## Stats');
	parts.push('');
	parts.push('| Metric | Value |');
	parts.push('|---|---|');

	if (fm.duration_min !== undefined) {
		parts.push(`| Duration | ${formatDuration(fm.duration_min)} |`);
	}
	if (fm.cost_usd !== undefined) {
		parts.push(`| Cost | $${fm.cost_usd.toFixed(2)} |`);
	}
	if (fm.user_turns !== undefined || fm.assistant_turns !== undefined) {
		const user = fm.user_turns ?? 0;
		const assistant = fm.assistant_turns ?? 0;
		parts.push(`| Turns | ${user} user / ${assistant} assistant |`);
	}
	if (fm.tools_used && fm.tools_used.length > 0) {
		parts.push(`| Tools | ${fm.tools_used.join(', ')} |`);
	}
	if (fm.input_tokens !== undefined || fm.output_tokens !== undefined) {
		const input = fm.input_tokens ?? 0;
		const output = fm.output_tokens ?? 0;
		const total = Math.round((input + output) / 1000);
		parts.push(`| Tokens | ${total}k total |`);
	}

	parts.push('');

	return parts.join('\n');
}

/**
 * Format duration in minutes to human-readable string.
 */
function formatDuration(minutes: number): string {
	if (minutes < 1) {
		return `${Math.round(minutes * 60)} sec`;
	}
	if (minutes < 60) {
		return `${Math.round(minutes)} min`;
	}
	const hours = Math.floor(minutes / 60);
	const mins = Math.round(minutes % 60);
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Merge Layer 0 note with LLM-generated content.
 *
 * Merge rules (per plan):
 * - Numeric (tokens, cost, duration): Layer 0 wins (exact parsed values)
 * - Narrative (Summary, Decisions, etc.): LLM wins (Layer 0 can't generate)
 * - files_touched: Merge both (Layer 0 more exhaustive)
 * - session_type: LLM wins (Layer 0 can't classify)
 * - tags: Merge both (Layer 0 has base, LLM has nested type tags)
 * - schema_version: Latest wins
 */
export function mergeNoteContent(
	layer0Content: string,
	llmContent: string
): string {
	const layer0Fm = extractFrontmatterSection(layer0Content);
	const llmFm = extractFrontmatterSection(llmContent);

	// If no LLM frontmatter or no narrative sections, just return Layer 0
	if (!llmFm || !llmContent.includes('## Summary')) {
		return layer0Content;
	}

	// If no Layer 0 frontmatter, return LLM content as-is
	if (!layer0Fm) {
		return llmContent;
	}

	// Parse both frontmatters
	const layer0Fields = parseFrontmatter(layer0Fm);
	const llmFields = parseFrontmatter(llmFm);

	// Merge according to rules
	const merged = mergeFrontmatterFields(layer0Fields, llmFields);

	// Extract body from LLM content (everything after frontmatter)
	const llmBody = extractBody(llmContent);

	// Rebuild note with merged frontmatter + LLM body
	return `---\n${merged}\n---\n${llmBody}`;
}

/**
 * Parse frontmatter YAML into key-value pairs.
 * Simple parser — handles scalars and arrays, not nested objects.
 */
function parseFrontmatter(yaml: string): Map<string, string | string[]> {
	const fields = new Map<string, string | string[]>();
	const lines = yaml.split('\n');

	let currentKey: string | null = null;
	let currentArray: string[] | null = null;

	for (const line of lines) {
		// Array item
		if (line.match(/^\s+-\s+/)) {
			const value = line.replace(/^\s+-\s+/, '').trim();
			if (currentArray && currentKey) {
				currentArray.push(unquote(value));
			}
			continue;
		}

		// Flush previous array
		if (currentArray && currentKey) {
			fields.set(currentKey, currentArray);
			currentArray = null;
			currentKey = null;
		}

		// Key-value or key-only (start of array)
		const match = line.match(/^([a-z_]+):\s*(.*)?$/);
		if (match) {
			const key = match[1];
			const value = match[2]?.trim() ?? '';

			if (value === '' || value.startsWith('[')) {
				// Empty value means block array follows, or it's a flow array
				if (value.startsWith('[') && value.endsWith(']')) {
					// Flow array: [a, b, c]
					const items = value.slice(1, -1).split(',').map(s => s.trim());
					fields.set(key, items);
				} else {
					// Block array follows
					currentKey = key;
					currentArray = [];
				}
			} else {
				// Scalar value
				fields.set(key, unquote(value));
			}
		}
	}

	// Flush final array
	if (currentArray && currentKey) {
		fields.set(currentKey, currentArray);
	}

	return fields;
}

/**
 * Remove quotes from a YAML string value.
 */
function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
	}
	return value;
}

/**
 * Merge frontmatter fields according to plan rules.
 */
function mergeFrontmatterFields(
	layer0: Map<string, string | string[]>,
	llm: Map<string, string | string[]>
): string {
	const merged = new Map<string, string | string[]>();

	// Start with all Layer 0 fields (they win on numerics)
	for (const [key, value] of layer0) {
		merged.set(key, value);
	}

	// LLM wins on: session_type (classification)
	const llmOnlyFields = ['session_type'];
	for (const key of llmOnlyFields) {
		if (llm.has(key)) {
			merged.set(key, llm.get(key)!);
		}
	}

	// Merge arrays: tags, files_touched
	const mergeArrayFields = ['tags', 'files_touched'];
	for (const key of mergeArrayFields) {
		const layer0Val = layer0.get(key);
		const llmVal = llm.get(key);

		if (layer0Val && llmVal) {
			const layer0Arr = Array.isArray(layer0Val) ? layer0Val : [layer0Val];
			const llmArr = Array.isArray(llmVal) ? llmVal : [llmVal];
			const combined = [...new Set([...layer0Arr, ...llmArr])].sort();
			merged.set(key, combined);
		} else if (llmVal) {
			merged.set(key, llmVal);
		}
	}

	// Serialize back to YAML
	return serializeMergedFrontmatter(merged);
}

/**
 * Serialize merged fields back to YAML string.
 */
function serializeMergedFrontmatter(fields: Map<string, string | string[]>): string {
	const lines: string[] = [];

	// Ordered keys for consistent output
	const orderedKeys = [
		'tags', 'session_id', 'schema_version',
		'project', 'cwd', 'branch', 'model',
		'start_time', 'duration_min',
		'cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens',
		'user_turns', 'assistant_turns',
		'tools_used', 'files_touched', 'error_count',
		'session_type', 'source_path', 'obsidian_uri',
	];

	// Track which keys we've output
	const output = new Set<string>();

	for (const key of orderedKeys) {
		if (!fields.has(key)) continue;
		output.add(key);

		const value = fields.get(key)!;
		lines.push(formatField(key, value));

		// Add blank line after sections
		if (['schema_version', 'model', 'duration_min', 'cache_read_tokens', 'assistant_turns', 'session_type'].includes(key)) {
			lines.push('');
		}
	}

	// Output any remaining keys not in ordered list
	for (const [key, value] of fields) {
		if (output.has(key)) continue;
		lines.push(formatField(key, value));
	}

	return lines.join('\n');
}

/**
 * Format a single frontmatter field.
 */
function formatField(key: string, value: string | string[]): string {
	if (Array.isArray(value)) {
		// Use flow style for tools_used, block style for others
		if (key === 'tools_used') {
			return `${key}: [${value.join(', ')}]`;
		}
		return `${key}:\n${value.map(v => `  - ${quoteIfNeeded(v)}`).join('\n')}`;
	}

	// Scalar
	return `${key}: ${quoteIfNeeded(value)}`;
}

/**
 * Quote a value if it contains special YAML characters.
 */
function quoteIfNeeded(value: string): string {
	if (typeof value !== 'string') return String(value);

	// Pure numeric values don't need quoting
	if (/^-?\d+(\.\d+)?$/.test(value)) return value;

	const needsQuote =
		value === '' ||
		value.startsWith(' ') ||
		value.endsWith(' ') ||
		/[:#\[\]{}|>&*!?'"\n\r\t\\]/.test(value) ||
		['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase());

	if (!needsQuote) return value;

	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n');

	return `"${escaped}"`;
}

/**
 * Extract frontmatter section from note content.
 */
function extractFrontmatterSection(content: string): string | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	return match ? match[1] : null;
}

/**
 * Extract body (everything after frontmatter) from note content.
 */
function extractBody(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
	return match ? match[1] : content;
}
