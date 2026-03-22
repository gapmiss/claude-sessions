import { BaseParser } from './base-parser';
import {
	Session, Turn, ContentBlock, TextBlock, ThinkingBlock,
	ToolUseBlock, ToolResultBlock, ImageBlock, HookEvent, SessionStats,
} from '../types';
import { extractProjectName, dirname } from '../utils/path-utils';

interface ClaudeRecord {
	type: string;
	uuid?: string;
	parentUuid?: string | null;
	sessionId?: string;
	cwd?: string;
	version?: string;
	gitBranch?: string;
	timestamp?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	toolUseID?: string;
	data?: {
		type?: string;
		hookEvent?: string;
		hookName?: string;
	};
	message?: {
		role?: string;
		content?: string | ClaudeContentBlock[];
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
}

interface ClaudeContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | ToolResultContent[];
	is_error?: boolean;
	source?: {
		type?: string;
		media_type?: string;
		data?: string;
	};
}

interface ToolResultContent {
	type: string;
	tool_use_id?: string;
	content?: string;
	text?: string;
	is_error?: boolean;
}

const SKIP_TYPES = new Set([
	'file-history-snapshot',
	'progress',
	'queue-operation',
]);

export class ClaudeParser extends BaseParser {
	readonly format = 'claude' as const;

	canParse(firstLines: string[]): boolean {
		for (const line of firstLines) {
			const record = this.tryParseJson(line);
			if (!record) continue;
			const type = record['type'] as string | undefined;
			if (type === 'user' || type === 'assistant') {
				const msg = record['message'] as Record<string, unknown> | undefined;
				if (msg && ('role' in msg)) return true;
			}
			if (type === 'file-history-snapshot' || record['sessionId']) return true;
		}
		return false;
	}

	parse(content: string, filePath: string): Session {
		const lines = this.splitLines(content);
		const records: ClaudeRecord[] = [];
		let sessionId = '';
		let cwd = '';
		let version = '';
		let branch = '';
		let model = '';
		let startTime = '';

		// Collect hook events by toolUseID
		const hookMap = new Map<string, HookEvent[]>();

		// Token usage per message ID (keep max of each field across streaming duplicates)
		const usageByMsg = new Map<string, { inp: number; out: number; cr: number; cc: number }>();

		// First pass: parse all records and extract metadata
		for (const line of lines) {
			const record = this.tryParseJson(line) as ClaudeRecord | null;
			if (!record) continue;

			// Capture hook_progress before skipping progress records
			if (record.type === 'progress' && record.data?.type === 'hook_progress'
				&& record.toolUseID && record.data.hookEvent && record.data.hookName) {
				const hooks = hookMap.get(record.toolUseID) ?? [];
				hooks.push({
					hookEvent: record.data.hookEvent,
					hookName: record.data.hookName,
					timestamp: record.timestamp,
				});
				hookMap.set(record.toolUseID, hooks);
			}

			// Track max token usage per message ID (streaming produces duplicates)
			if (record.type === 'assistant' && record.message?.usage) {
				const msgId = (record.message as Record<string, unknown>)['id'] as string | undefined;
				if (msgId) {
					const u = record.message.usage;
					const prev = usageByMsg.get(msgId);
					usageByMsg.set(msgId, {
						inp: Math.max(prev?.inp ?? 0, u.input_tokens ?? 0),
						out: Math.max(prev?.out ?? 0, u.output_tokens ?? 0),
						cr: Math.max(prev?.cr ?? 0, u.cache_read_input_tokens ?? 0),
						cc: Math.max(prev?.cc ?? 0, u.cache_creation_input_tokens ?? 0),
					});
				}
			}

			if (SKIP_TYPES.has(record.type)) continue;
			if (record.isSidechain) continue;
			if (record.isMeta) continue;

			if (record.sessionId && !sessionId) sessionId = record.sessionId;
			if (record.cwd && !cwd) cwd = record.cwd;
			if (record.version && !version) version = record.version;
			if (record.gitBranch && !branch) branch = record.gitBranch;
			if (record.timestamp && !startTime) startTime = record.timestamp;
			if (record.message?.model && !model) model = record.message.model;

			records.push(record);
		}

		// Deduplicate by uuid — keep the most complete (last) record
		const byUuid = new Map<string, ClaudeRecord>();
		const ordered: ClaudeRecord[] = [];
		for (const record of records) {
			if (record.uuid) {
				if (byUuid.has(record.uuid)) {
					// Replace with newer version (more content)
					const idx = ordered.indexOf(byUuid.get(record.uuid)!);
					if (idx !== -1) ordered[idx] = record;
				} else {
					ordered.push(record);
				}
				byUuid.set(record.uuid, record);
			} else {
				ordered.push(record);
			}
		}

		// Second pass: build turns by merging consecutive same-role records.
		// Claude streams assistant responses as multiple records (thinking, text, tool_use),
		// each with its own uuid. These should form a single assistant turn.
		// User records containing only tool_result blocks should have those results
		// attached to the preceding assistant turn (not become separate user turns).
		const turns: Turn[] = [];
		const toolUseNames = new Map<string, string>();

		let currentAssistantTurn: Turn | null = null;

		const flushAssistant = () => {
			if (currentAssistantTurn && currentAssistantTurn.contentBlocks.length > 0) {
				currentAssistantTurn.index = turns.length;
				turns.push(currentAssistantTurn);
			}
			currentAssistantTurn = null;
		};

		for (const record of ordered) {
			if (record.type === 'assistant') {
				// Merge into current assistant turn, or start a new one
				const blocks = this.parseAssistantBlocks(record, toolUseNames);
				if (blocks.length === 0) continue;

				if (!currentAssistantTurn) {
					currentAssistantTurn = {
						index: 0,
						role: 'assistant',
						timestamp: this.formatTimestamp(record.timestamp),
						endTimestamp: this.formatTimestamp(record.timestamp),
						contentBlocks: [],
					};
				}
				// Always update endTimestamp with the latest record
				if (record.timestamp) {
					currentAssistantTurn.endTimestamp = this.formatTimestamp(record.timestamp);
				}
				for (const b of blocks) {
					currentAssistantTurn.contentBlocks.push(b);
				}
			} else if (record.type === 'user') {
				// Check for tool_result blocks
				const toolResults = this.extractToolResultBlocks(record, toolUseNames);

				if (toolResults.length > 0 && currentAssistantTurn) {
					// Attach results to the current (not-yet-flushed) assistant turn
					for (const result of toolResults) {
						currentAssistantTurn.contentBlocks.push(result);
					}
					// Update endTimestamp — tool results complete after the tool_use
					if (record.timestamp) {
						currentAssistantTurn.endTimestamp = this.formatTimestamp(record.timestamp);
					}
				} else if (toolResults.length > 0) {
					// No current assistant turn — attach to the last one in the list
					const lastAssistant = this.findLastAssistantTurn(turns);
					if (lastAssistant) {
						for (const result of toolResults) {
							lastAssistant.contentBlocks.push(result);
						}
						if (record.timestamp) {
							lastAssistant.endTimestamp = this.formatTimestamp(record.timestamp);
						}
					}
				}

				// Check if this user record has actual user content (text and/or images)
				const userBlocks = this.extractUserContent(record);
				if (userBlocks.length > 0) {
					// Flush any pending assistant turn before the user turn
					flushAssistant();
					const ts = this.formatTimestamp(record.timestamp);
					turns.push({
						index: turns.length,
						role: 'user',
						timestamp: ts,
						endTimestamp: ts,
						contentBlocks: userBlocks,
					});
				}
			}
		}

		// Flush any remaining assistant turn
		flushAssistant();

		// Attach hook events to their corresponding tool_use blocks
		if (hookMap.size > 0) {
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === 'tool_use' && hookMap.has(block.id)) {
						block.hooks = hookMap.get(block.id);
					}
				}
			}
		}

		const project = extractProjectName(dirname(filePath));

		// Compute stats
		const toolUseCounts: Record<string, number> = {};
		let userTurns = 0;
		let assistantTurns = 0;
		for (const turn of turns) {
			if (turn.role === 'user') userTurns++;
			else assistantTurns++;
			for (const block of turn.contentBlocks) {
				if (block.type === 'tool_use') {
					toolUseCounts[block.name] = (toolUseCounts[block.name] ?? 0) + 1;
				}
			}
		}

		// Duration from first to last timestamp
		let durationMs = 0;
		if (turns.length > 0) {
			const first = turns[0].timestamp;
			const lastTurn = turns[turns.length - 1];
			const last = lastTurn.endTimestamp ?? lastTurn.timestamp;
			if (first && last) {
				durationMs = new Date(last).getTime() - new Date(first).getTime();
			}
		}

		// Sum token usage across all unique messages
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCacheCreationTokens = 0;
		for (const u of usageByMsg.values()) {
			totalInputTokens += u.inp;
			totalOutputTokens += u.out;
			totalCacheReadTokens += u.cr;
			totalCacheCreationTokens += u.cc;
		}

		const stats: SessionStats = {
			userTurns,
			assistantTurns,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: totalCacheReadTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			toolUseCounts,
			durationMs,
		};

		return {
			metadata: {
				id: sessionId || basename(filePath),
				format: 'claude',
				project,
				cwd,
				branch: branch || undefined,
				model: model || undefined,
				version: version || undefined,
				startTime: this.formatTimestamp(startTime),
				totalTurns: turns.length,
			},
			stats,
			turns,
			rawPath: filePath,
		};
	}

	private parseAssistantBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>
	): ContentBlock[] {
		const msg = record.message;
		if (!msg) return [];

		const timestamp = record.timestamp;
		const blocks: ContentBlock[] = [];
		if (typeof msg.content === 'string') {
			if (msg.content.trim()) {
				blocks.push({ type: 'text', text: msg.content, timestamp });
			}
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content as ClaudeContentBlock[]) {
				const parsed = this.parseContentBlock(block, toolUseNames, timestamp);
				if (parsed) blocks.push(parsed);
			}
		}
		return blocks;
	}

	private extractToolResultBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>
	): ToolResultBlock[] {
		const msg = record.message;
		if (!msg) return [];

		const timestamp = record.timestamp;
		const results: ToolResultBlock[] = [];
		if (Array.isArray(msg.content)) {
			for (const block of msg.content as ClaudeContentBlock[]) {
				if (block.type === 'tool_result' && block.tool_use_id) {
					const resultContent = typeof block.content === 'string'
						? block.content
						: Array.isArray(block.content)
							? (block.content as ToolResultContent[])
								.map(c => c.text ?? c.content ?? '')
								.filter(s => s)
								.join('\n')
							: '';

					results.push({
						type: 'tool_result',
						toolUseId: block.tool_use_id,
						toolName: toolUseNames.get(block.tool_use_id),
						content: resultContent,
						isError: block.is_error || false,
						timestamp,
					});
				}
			}
		}
		return results;
	}

	/** Extract user content blocks from a record, handling string, text, and image blocks. */
	private extractUserContent(record: ClaudeRecord): ContentBlock[] {
		const content = record.message?.content;
		const timestamp = record.timestamp;
		if (typeof content === 'string') {
			// Consolidate /exit command sequences into a single subtle message
			if (/<command-name>\/exit<\/command-name>/.test(content)) {
				return [{ type: 'text', text: '*Session ended*', timestamp } as TextBlock];
			}
			// Skip local command output that follows /exit (e.g. "Goodbye!")
			if (/<local-command-stdout>/.test(content)) {
				return [];
			}
			// Skip local command caveats (usually also filtered by isMeta)
			if (/<local-command-caveat>/.test(content)) {
				return [];
			}
			// Strip image source reference lines (e.g. "[Image: source: /path/to/file.png]")
			const cleaned = content.replace(/\[Image:\s*source:\s*.+?\]/gi, '').trim();
			if (!cleaned) {
				return [];
			}
			return [{ type: 'text', text: cleaned, timestamp } as TextBlock];
		}
		if (Array.isArray(content)) {
			const blocks: ContentBlock[] = [];
			for (const block of content as ClaudeContentBlock[]) {
				if (block.type === 'text' && block.text?.trim()) {
					blocks.push({ type: 'text', text: block.text, timestamp } as TextBlock);
				} else if (block.type === 'image' && block.source?.data) {
					blocks.push({
						type: 'image',
						mediaType: block.source.media_type ?? 'image/png',
						data: block.source.data,
						timestamp,
					} as ImageBlock);
				}
			}
			return blocks;
		}
		return [];
	}

	private findLastAssistantTurn(turns: Turn[]): Turn | null {
		for (let i = turns.length - 1; i >= 0; i--) {
			if (turns[i].role === 'assistant') return turns[i];
		}
		return null;
	}

	private parseContentBlock(
		block: ClaudeContentBlock,
		toolUseNames: Map<string, string>,
		timestamp?: string
	): ContentBlock | null {
		switch (block.type) {
			case 'text':
				if (block.text && block.text.trim()) {
					return { type: 'text', text: block.text, timestamp } as TextBlock;
				}
				return null;

			case 'thinking':
				if (block.thinking && block.thinking.trim()) {
					return { type: 'thinking', thinking: block.thinking, timestamp } as ThinkingBlock;
				}
				// Encrypted thinking (signature-only) — skip, nothing useful to display
				return null;

			case 'tool_use':
				if (block.id && block.name) {
					toolUseNames.set(block.id, block.name);
					return {
						type: 'tool_use',
						id: block.id,
						name: block.name,
						input: block.input || {},
						timestamp,
					} as ToolUseBlock;
				}
				return null;

			default:
				return null;
		}
	}
}

function basename(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	const last = parts[parts.length - 1] || '';
	return last.replace(/\.jsonl$/, '');
}
