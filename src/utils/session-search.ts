import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as readline from 'readline';
import type { Turn, TurnRole, SessionListEntry } from '../types';
import { BM25Index } from './bm25';
import { SKIP_TYPE_STRINGS, SUBTYPE_LOCAL_COMMAND, RE_COMMAND_NAME, RE_COMMAND_ARGS } from '../constants';

// ── Types ────────────────────────────────────────────────────

export interface SearchQuery {
	text: string;
	caseSensitive?: boolean;
	roleFilter?: 'all' | 'user' | 'assistant';
}

export interface SearchMatch {
	turnIndex: number;
	role: TurnRole;
	blockType: string;
	toolName?: string;
	matchText: string;
	contextBefore: string;
	contextAfter: string;
	timestamp?: string;
	/** BM25 relevance score (only set when using ranked search). */
	score?: number;
}

export interface SessionSearchResult {
	entry: SessionListEntry;
	matches: SearchMatch[];
	totalMatches: number;
}

// ── Lightweight per-line content extraction ──────────────────

interface ExtractedContent {
	role: TurnRole;
	blockType: string;
	text: string;
	toolName?: string;
	timestamp?: string;
}

/**
 * Extract human-readable text from tool input, matching how toolPreview() renders it.
 */
function extractToolInputText(toolName: string, input: Record<string, unknown> | undefined): string {
	if (!input) return '';

	const str = (key: string): string => {
		const val = input[key];
		return typeof val === 'string' ? val : '';
	};

	switch (toolName) {
		case 'Bash':
			return str('command') || str('description');
		case 'Read':
		case 'Write':
		case 'Edit':
			return str('file_path');
		case 'Grep':
		case 'Glob':
			return str('pattern');
		case 'Agent':
		case 'Task':
			return [str('description'), str('prompt')].filter(Boolean).join(' ');
		case 'WebFetch':
			return str('url');
		case 'WebSearch':
			return str('query');
		case 'AskUserQuestion': {
			const qs = input['questions'] as Array<Record<string, unknown>> | undefined;
			if (qs?.length) {
				return qs.map(q => typeof q['question'] === 'string' ? q['question'] : '').join(' ');
			}
			return '';
		}
		default: {
			const nameField = input['name'] ?? input['path'] ?? input['file'] ?? input['query'] ?? input['command'];
			if (typeof nameField === 'string') return nameField;
			return Object.entries(input)
				.filter(([, v]) => typeof v === 'string')
				.map(([, v]) => v as string)
				.join(' ')
				.slice(0, 200);
		}
	}
}

/**
 * Extract searchable text from a single JSONL line without full parsing.
 * Returns null for non-content records.
 */
/** @visibleForTesting */
export function extractSearchableContent(line: string): ExtractedContent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	// Quick skip for large/irrelevant record types
	const head = trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
	for (const sub of SKIP_TYPE_STRINGS) {
		if (head.includes(sub)) return null;
	}

	let record: Record<string, unknown>;
	try {
		record = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}

	// Skip sidechain and meta records
	if (record['isSidechain'] || record['isMeta']) return null;

	const recordType = record['type'] as string | undefined;
	const timestamp = record['timestamp'] as string | undefined;
	const message = record['message'] as Record<string, unknown> | undefined;

	if (recordType === 'assistant') {
		if (!message) return null;
		// Skip synthetic model
		if (message['model'] === '<synthetic>') return null;

		const content = message['content'] as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(content)) return null;

		for (const block of content) {
			const blockType = block['type'] as string;

			if (blockType === 'text' && typeof block['text'] === 'string') {
				return { role: 'assistant', blockType: 'text', text: block['text'], timestamp };
			}
			if (blockType === 'thinking' && typeof block['thinking'] === 'string' && block['thinking']) {
				return { role: 'assistant', blockType: 'thinking', text: block['thinking'], timestamp };
			}
			if (blockType === 'tool_use') {
				const name = (block['name'] as string) || '';
				const input = block['input'] as Record<string, unknown> | undefined;
				const inputText = extractToolInputText(name, input);
				return { role: 'assistant', blockType: 'tool_use', text: `${name} ${inputText}`, toolName: name, timestamp };
			}
		}
		return null;
	}

	if (recordType === 'user') {
		if (!message) return null;
		const content = message['content'];
		// String content = actual user text
		if (typeof content === 'string') {
			return { role: 'user', blockType: 'text', text: content, timestamp };
		}
		// Array content = tool results
		if (Array.isArray(content)) {
			const texts: string[] = [];
			for (const block of content) {
				if ((block as Record<string, unknown>)['type'] === 'tool_result') {
					const c = (block as Record<string, unknown>)['content'];
					if (typeof c === 'string') texts.push(c);
				}
			}
			if (texts.length > 0) {
				return { role: 'assistant', blockType: 'tool_result', text: texts.join('\n'), timestamp };
			}
		}
		return null;
	}

	// Handle system records with slash commands
	if (recordType === 'system') {
		const subtype = record['subtype'] as string | undefined;
		const content = record['content'] as string | undefined;

		if (subtype === SUBTYPE_LOCAL_COMMAND && content) {
			const cmdMatch = content.match(RE_COMMAND_NAME);
			if (cmdMatch) {
				const commandName = cmdMatch[1];
				const argsMatch = content.match(RE_COMMAND_ARGS);
				const args = argsMatch ? argsMatch[1].trim() : '';
				const text = args ? `${commandName} ${args}` : commandName;
				return { role: 'user', blockType: 'slash_command', text, timestamp };
			}
		}
		return null;
	}

	return null;
}

// ── Single-file search ──────────────────────────────────────

const CONTEXT_CHARS = 75;
const DEFAULT_MAX_MATCHES = 20;

/**
 * Search a single JSONL file line-by-line. Returns matches with context.
 */
export async function searchFile(
	filePath: string,
	query: SearchQuery,
	maxMatches = DEFAULT_MAX_MATCHES,
	signal?: AbortSignal,
): Promise<{ matches: SearchMatch[]; totalMatches: number }> {
	if (!Platform.isDesktop) return { matches: [], totalMatches: 0 };

	const searchText = query.caseSensitive ? query.text : query.text.toLowerCase();
	const matches: SearchMatch[] = [];
	let totalMatches = 0;
	let approxTurnIndex = 0;
	let lastRole: string | null = null;

	return new Promise((resolve) => {
		let stream: ReturnType<typeof fs.createReadStream>;
		try {
			stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
		} catch {
			resolve({ matches, totalMatches });
			return;
		}

		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		const cleanup = () => {
			rl.close();
			stream.destroy();
		};

		if (signal) {
			signal.addEventListener('abort', cleanup, { once: true });
		}

		rl.on('line', (line: string) => {
			if (signal?.aborted) return;

			const extracted = extractSearchableContent(line);
			if (!extracted) return;

			// Track approximate turn index via role transitions
			if (extracted.role !== lastRole) {
				if (lastRole !== null) approxTurnIndex++;
				lastRole = extracted.role;
			}

			// Role filter
			if (query.roleFilter && query.roleFilter !== 'all' && extracted.role !== query.roleFilter) {
				return;
			}

			// Search
			const haystack = query.caseSensitive ? extracted.text : extracted.text.toLowerCase();
			let searchFrom = 0;
			while (true) {
				const idx = haystack.indexOf(searchText, searchFrom);
				if (idx === -1) break;

				totalMatches++;
				if (matches.length < maxMatches) {
					const matchEnd = idx + searchText.length;
					matches.push({
						turnIndex: approxTurnIndex,
						role: extracted.role,
						blockType: extracted.blockType,
						toolName: extracted.toolName,
						matchText: extracted.text.slice(idx, matchEnd),
						contextBefore: extracted.text.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
						contextAfter: extracted.text.slice(matchEnd, matchEnd + CONTEXT_CHARS),
						timestamp: extracted.timestamp,
					});
				}

				searchFrom = idx + 1;
			}
		});

		rl.on('close', () => {
			resolve({ matches, totalMatches });
		});

		stream.on('error', () => {
			resolve({ matches, totalMatches });
		});
	});
}

// ── Multi-session orchestrator ──────────────────────────────

/**
 * Search across multiple session files. Processes newest first.
 * Calls onResult per session that has matches. Calls onProgress with counts.
 */
/** Map a search match to the correct parsed turn index using timestamps. */
export function resolveMatchTurn(match: SearchMatch, turns: Turn[]): number {
	if (!turns.length) return 0;

	if (match.timestamp) {
		const matchMs = new Date(match.timestamp).getTime();
		if (!isNaN(matchMs)) {
			for (let i = 0; i < turns.length; i++) {
				const turnMs = turns[i].timestamp ? new Date(turns[i].timestamp!).getTime() : NaN;
				const nextMs = i + 1 < turns.length && turns[i + 1].timestamp
					? new Date(turns[i + 1].timestamp!).getTime()
					: Infinity;
				if (!isNaN(turnMs) && matchMs >= turnMs && matchMs < nextMs) {
					return i;
				}
			}
		}
	}

	return Math.min(match.turnIndex, turns.length - 1);
}

export async function searchSessions(
	entries: SessionListEntry[],
	query: SearchQuery,
	onResult: (result: SessionSearchResult) => void,
	onProgress: (searched: number, total: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	for (let i = 0; i < entries.length; i++) {
		if (signal?.aborted) return;

		const entry = entries[i];
		const { matches, totalMatches } = await searchFile(entry.path, query, DEFAULT_MAX_MATCHES, signal);

		if (matches.length > 0) {
			onResult({ entry, matches, totalMatches });
		}

		onProgress(i + 1, entries.length);
	}
}

// ── BM25 ranked search ────────────────────────────────────

/**
 * Search a single JSONL file using exact substring matching, ranked by BM25.
 * Finds exact matches (same as searchFile), then scores each match's
 * containing document with BM25 for relevance sorting.
 */
export async function searchFileRanked(
	filePath: string,
	query: SearchQuery,
	maxMatches = DEFAULT_MAX_MATCHES,
	signal?: AbortSignal,
): Promise<{ matches: SearchMatch[]; totalMatches: number }> {
	if (!Platform.isDesktop) return { matches: [], totalMatches: 0 };

	const searchText = query.caseSensitive ? query.text : query.text.toLowerCase();
	const index = new BM25Index<null>();
	const matches: (SearchMatch & { docId: string })[] = [];
	let totalMatches = 0;
	let approxTurnIndex = 0;
	let lastRole: string | null = null;
	let docId = 0;

	await new Promise<void>((resolve) => {
		let stream: ReturnType<typeof fs.createReadStream>;
		try {
			stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
		} catch {
			resolve();
			return;
		}

		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		const cleanup = () => {
			rl.close();
			stream.destroy();
		};

		if (signal) {
			signal.addEventListener('abort', cleanup, { once: true });
		}

		rl.on('line', (line: string) => {
			if (signal?.aborted) return;

			const extracted = extractSearchableContent(line);
			if (!extracted) return;

			// Track turn index
			if (extracted.role !== lastRole) {
				if (lastRole !== null) approxTurnIndex++;
				lastRole = extracted.role;
			}

			// Role filter
			if (query.roleFilter && query.roleFilter !== 'all' && extracted.role !== query.roleFilter) {
				return;
			}

			// Add every document to the BM25 index for scoring
			const id = String(docId++);
			index.add(id, extracted.text, null);

			// Find exact substring matches (same logic as searchFile)
			const haystack = query.caseSensitive ? extracted.text : extracted.text.toLowerCase();
			let searchFrom = 0;
			while (true) {
				const idx = haystack.indexOf(searchText, searchFrom);
				if (idx === -1) break;

				totalMatches++;
				const matchEnd = idx + searchText.length;
				matches.push({
					docId: id,
					turnIndex: approxTurnIndex,
					role: extracted.role,
					blockType: extracted.blockType,
					toolName: extracted.toolName,
					matchText: extracted.text.slice(idx, matchEnd),
					contextBefore: extracted.text.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
					contextAfter: extracted.text.slice(matchEnd, matchEnd + CONTEXT_CHARS),
					timestamp: extracted.timestamp,
				});

				searchFrom = idx + 1;
			}
		});

		rl.on('close', () => resolve());
		stream.on('error', () => resolve());
	});

	if (signal?.aborted) return { matches: [], totalMatches: 0 };

	// Score each match's document with BM25 and sort by relevance
	const scoreMap = new Map<string, number>();
	const ranked = index.search(query.text, index.size);
	for (const r of ranked) {
		scoreMap.set(r.id, r.score);
	}

	matches.sort((a, b) => (scoreMap.get(b.docId) ?? 0) - (scoreMap.get(a.docId) ?? 0));

	// Strip internal docId and cap results
	const result: SearchMatch[] = matches.slice(0, maxMatches).map(({ docId: _id, ...m }) => ({
		...m,
		score: scoreMap.get(_id) ?? 0,
	}));

	return { matches: result, totalMatches };
}

/**
 * Search across sessions using BM25 ranking.
 * Results within each session are ranked by relevance.
 */
export async function searchSessionsRanked(
	entries: SessionListEntry[],
	query: SearchQuery,
	onResult: (result: SessionSearchResult) => void,
	onProgress: (searched: number, total: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	for (let i = 0; i < entries.length; i++) {
		if (signal?.aborted) return;

		const entry = entries[i];
		const { matches, totalMatches } = await searchFileRanked(entry.path, query, DEFAULT_MAX_MATCHES, signal);

		if (matches.length > 0) {
			onResult({ entry, matches, totalMatches });
		}

		onProgress(i + 1, entries.length);
	}
}
