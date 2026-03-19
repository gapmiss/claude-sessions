import { BaseParser } from './base-parser';
import {
	Session, Turn, ContentBlock, TextBlock, ThinkingBlock,
	ToolUseBlock, ToolResultBlock,
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
	message?: {
		role?: string;
		content?: string | ClaudeContentBlock[];
		model?: string;
	};
}

interface ClaudeContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | ToolResultContent[];
	is_error?: boolean;
}

interface ToolResultContent {
	type: string;
	tool_use_id: string;
	content: string;
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

		// First pass: parse all records and extract metadata
		for (const line of lines) {
			const record = this.tryParseJson(line) as ClaudeRecord | null;
			if (!record) continue;
			if (SKIP_TYPES.has(record.type)) continue;
			if (record.isSidechain) continue;

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

		// Second pass: build turns
		const turns: Turn[] = [];
		// Track tool_use blocks for matching with results
		const toolUseNames = new Map<string, string>();

		for (const record of ordered) {
			if (record.type === 'user') {
				const turn = this.buildUserTurn(record, turns.length);
				if (turn) {
					// Extract tool results from user messages
					this.extractToolResults(record, turn, toolUseNames);
					if (turn.contentBlocks.length > 0) {
						turns.push(turn);
					}
				}
			} else if (record.type === 'assistant') {
				const turn = this.buildAssistantTurn(record, turns.length, toolUseNames);
				if (turn && turn.contentBlocks.length > 0) {
					turns.push(turn);
				}
			}
		}

		const project = extractProjectName(dirname(filePath));

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
			turns,
			rawPath: filePath,
		};
	}

	private buildUserTurn(record: ClaudeRecord, index: number): Turn | null {
		const msg = record.message;
		if (!msg) return null;

		const blocks: ContentBlock[] = [];
		if (typeof msg.content === 'string' && msg.content.trim()) {
			blocks.push({ type: 'text', text: msg.content });
		}

		return {
			index,
			role: 'user',
			timestamp: this.formatTimestamp(record.timestamp),
			contentBlocks: blocks,
		};
	}

	private extractToolResults(
		record: ClaudeRecord,
		turn: Turn,
		toolUseNames: Map<string, string>
	): void {
		const msg = record.message;
		if (!msg) return;

		if (Array.isArray(msg.content)) {
			for (const block of msg.content as ClaudeContentBlock[]) {
				if (block.type === 'tool_result' && block.tool_use_id) {
					const resultContent = typeof block.content === 'string'
						? block.content
						: Array.isArray(block.content)
							? (block.content as ToolResultContent[])
								.map(c => c.content)
								.join('\n')
							: '';

					const resultBlock: ToolResultBlock = {
						type: 'tool_result',
						toolUseId: block.tool_use_id,
						toolName: toolUseNames.get(block.tool_use_id),
						content: resultContent,
						isError: block.is_error || false,
					};
					turn.contentBlocks.push(resultBlock);
				}
			}
		}
	}

	private buildAssistantTurn(
		record: ClaudeRecord,
		index: number,
		toolUseNames: Map<string, string>
	): Turn | null {
		const msg = record.message;
		if (!msg) return null;

		const blocks: ContentBlock[] = [];

		if (typeof msg.content === 'string') {
			if (msg.content.trim()) {
				blocks.push({ type: 'text', text: msg.content });
			}
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content as ClaudeContentBlock[]) {
				const parsed = this.parseContentBlock(block, toolUseNames);
				if (parsed) blocks.push(parsed);
			}
		}

		return {
			index,
			role: 'assistant',
			timestamp: this.formatTimestamp(record.timestamp),
			contentBlocks: blocks,
		};
	}

	private parseContentBlock(
		block: ClaudeContentBlock,
		toolUseNames: Map<string, string>
	): ContentBlock | null {
		switch (block.type) {
			case 'text':
				if (block.text && block.text.trim()) {
					return { type: 'text', text: block.text } as TextBlock;
				}
				return null;

			case 'thinking':
				if (block.thinking && block.thinking.trim()) {
					return { type: 'thinking', thinking: block.thinking } as ThinkingBlock;
				}
				return null;

			case 'tool_use':
				if (block.id && block.name) {
					toolUseNames.set(block.id, block.name);
					return {
						type: 'tool_use',
						id: block.id,
						name: block.name,
						input: block.input || {},
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
