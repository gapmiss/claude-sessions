import { BaseParser } from './base-parser';
import { Session, Turn, ContentBlock } from '../types';
import { extractProjectName, dirname } from '../utils/path-utils';

interface CodexRecord {
	type: string;
	session_id?: string;
	model?: string;
	instructions?: string;
	cwd?: string;
	timestamp?: string;
	item?: {
		type: string;
		role?: string;
		content?: CodexContent[];
		id?: string;
		call_id?: string;
		name?: string;
		arguments?: string;
		output?: string;
		status?: string;
	};
	event?: string;
	data?: string;
}

interface CodexContent {
	type: string;
	text?: string;
	annotations?: unknown[];
}

export class CodexParser extends BaseParser {
	readonly format = 'codex' as const;

	canParse(firstLines: string[]): boolean {
		for (const line of firstLines) {
			const record = this.tryParseJson(line);
			if (!record) continue;
			const type = record['type'] as string | undefined;
			if (type === 'session_meta' || type === 'response_item' || type === 'event_msg') {
				return true;
			}
		}
		return false;
	}

	parse(content: string, filePath: string): Session {
		const lines = this.splitLines(content);
		const turns: Turn[] = [];
		let sessionId = '';
		let model = '';
		let cwd = '';
		let startTime = '';

		for (const line of lines) {
			const record = this.tryParseJson(line) as CodexRecord | null;
			if (!record) continue;

			switch (record.type) {
				case 'session_meta':
					if (record.session_id) sessionId = record.session_id;
					if (record.model) model = record.model;
					if (record.cwd) cwd = record.cwd;
					if (record.timestamp && !startTime) startTime = record.timestamp;
					break;

				case 'response_item':
					this.processResponseItem(record, turns);
					break;
			}
		}

		const project = extractProjectName(dirname(filePath));

		return {
			metadata: {
				id: sessionId || fileBasename(filePath),
				format: 'codex',
				project,
				cwd,
				model: model || undefined,
				startTime: this.formatTimestamp(startTime),
				totalTurns: turns.length,
			},
			turns,
			rawPath: filePath,
		};
	}

	private processResponseItem(record: CodexRecord, turns: Turn[]): void {
		const item = record.item;
		if (!item) return;

		const blocks: ContentBlock[] = [];

		if (item.type === 'message' && item.content) {
			for (const c of item.content) {
				if (c.type === 'output_text' || c.type === 'input_text') {
					if (c.text && c.text.trim()) {
						blocks.push({ type: 'text', text: c.text });
					}
				}
			}
		} else if (item.type === 'function_call') {
			if (item.name) {
				let input: Record<string, unknown> = {};
				if (item.arguments) {
					try {
						input = JSON.parse(item.arguments) as Record<string, unknown>;
					} catch {
						input = { raw: item.arguments };
					}
				}
				blocks.push({
					type: 'tool_use',
					id: item.call_id || item.id || '',
					name: item.name,
					input,
				});
			}
		} else if (item.type === 'function_call_output') {
			if (item.output) {
				blocks.push({
					type: 'tool_result',
					toolUseId: item.call_id || '',
					content: item.output,
					isError: item.status === 'failed',
				});
			}
		}

		if (blocks.length > 0) {
			const role = item.role === 'user' ? 'user' as const : 'assistant' as const;
			turns.push({
				index: turns.length,
				role,
				timestamp: this.formatTimestamp(record.timestamp),
				contentBlocks: blocks,
			});
		}
	}
}

function fileBasename(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	const last = parts[parts.length - 1] || '';
	return last.replace(/\.\w+$/, '');
}
