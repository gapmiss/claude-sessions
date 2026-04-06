import { Platform } from 'obsidian';
import type { Turn, TurnRole, SessionListEntry } from '../types';
import { BM25Index, analyze } from './bm25';

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

// ── Skip types (same pattern as streaming-reader.ts) ─────────

const SKIP_TYPE_STRINGS = [
	'"type":"file-history-snapshot"',
	'"type":"queue-operation"',
	'"type":"progress"',
];

// ── Lightweight per-line content extraction ──────────────────

interface ExtractedContent {
	role: TurnRole;
	blockType: string;
	text: string;
	toolName?: string;
	timestamp?: string;
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
		record = JSON.parse(trimmed);
	} catch {
		return null;
	}

	// Skip sidechain and meta records
	if (record['isSidechain'] || record['isMeta']) return null;

	const recordType = record['type'] as string | undefined;
	const timestamp = record['timestamp'] as string | undefined;
	const message = record['message'] as Record<string, unknown> | undefined;
	if (!message) return null;

	if (recordType === 'assistant') {
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
				// Concatenate tool name + stringified input for search
				const inputStr = input ? JSON.stringify(input) : '';
				return { role: 'assistant', blockType: 'tool_use', text: `${name} ${inputStr}`, toolName: name, timestamp };
			}
		}
		return null;
	}

	if (recordType === 'user') {
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

	const fs = require('fs') as typeof import('fs');
	const readline = require('readline') as typeof import('readline');

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

/** Payload stored per BM25 document (one per JSONL content line). */
interface RankedDocPayload {
	role: TurnRole;
	blockType: string;
	toolName?: string;
	text: string;
	turnIndex: number;
	timestamp?: string;
}

/**
 * Search a single JSONL file using BM25 relevance ranking.
 * Returns matches sorted by score (best first) instead of document order.
 */
export async function searchFileRanked(
	filePath: string,
	query: SearchQuery,
	maxMatches = DEFAULT_MAX_MATCHES,
	signal?: AbortSignal,
): Promise<{ matches: SearchMatch[]; totalMatches: number }> {
	if (!Platform.isDesktop) return { matches: [], totalMatches: 0 };

	const fs = require('fs') as typeof import('fs');
	const readline = require('readline') as typeof import('readline');

	const index = new BM25Index<RankedDocPayload>();
	let docId = 0;
	let approxTurnIndex = 0;
	let lastRole: string | null = null;

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

			const id = String(docId++);
			index.add(id, extracted.text, {
				role: extracted.role,
				blockType: extracted.blockType,
				toolName: extracted.toolName,
				text: extracted.text,
				turnIndex: approxTurnIndex,
				timestamp: extracted.timestamp,
			});
		});

		rl.on('close', () => resolve());
		stream.on('error', () => resolve());
	});

	if (signal?.aborted) return { matches: [], totalMatches: 0 };

	// Query the index
	const ranked = index.search(query.text, maxMatches * 2);
	const totalMatches = ranked.length;

	// Build SearchMatch objects with context snippets
	const searchText = query.caseSensitive ? query.text : query.text.toLowerCase();
	const matches: SearchMatch[] = [];

	for (const result of ranked) {
		if (matches.length >= maxMatches) break;

		const { data } = result;
		const haystack = query.caseSensitive ? data.text : data.text.toLowerCase();

		// Find the best substring match for snippet context
		// First try exact substring; fall back to first query term
		let idx = haystack.indexOf(searchText);
		if (idx === -1) {
			// Find first matching stemmed term position (approximate snippet)
			const queryTerms = analyze(query.text);
			for (const term of queryTerms) {
				idx = haystack.indexOf(term);
				if (idx !== -1) break;
			}
		}

		if (idx === -1) idx = 0;
		const snippetEnd = Math.min(idx + searchText.length, data.text.length);

		matches.push({
			turnIndex: data.turnIndex,
			role: data.role,
			blockType: data.blockType,
			toolName: data.toolName,
			matchText: data.text.slice(idx, snippetEnd),
			contextBefore: data.text.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
			contextAfter: data.text.slice(snippetEnd, snippetEnd + CONTEXT_CHARS),
			timestamp: data.timestamp,
			score: result.score,
		});
	}

	return { matches, totalMatches };
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
