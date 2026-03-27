import type { ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, ToolResultImage } from '../types';
import { BT_TEXT, BT_THINKING, BT_TOOL_USE, BT_TOOL_RESULT, PREFIX_INTERRUPTION } from '../constants';

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
}

interface ToolResultContent {
	type: string;
	text?: string;
	content?: string;
	source?: { type?: string; media_type?: string; data?: string };
}

interface RecordMessage {
	content?: string | ClaudeContentBlock[];
}

/** Parse a single content block from an assistant record. */
export function parseContentBlock(
	block: ClaudeContentBlock,
	toolUseNames: Map<string, string>,
	timestamp?: string,
	unknownBlockTypes?: Map<string, number>,
): ContentBlock | null {
	switch (block.type) {
		case BT_TEXT:
			if (block.text && block.text.trim()) {
				return { type: 'text', text: block.text, timestamp } as TextBlock;
			}
			return null;

		case BT_THINKING:
			if (block.thinking && block.thinking.trim()) {
				return { type: 'thinking', thinking: block.thinking, timestamp } as ThinkingBlock;
			}
			// Encrypted thinking (signature-only) — skip, nothing useful to display
			return null;

		case BT_TOOL_USE:
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
			if (unknownBlockTypes && block.type) {
				unknownBlockTypes.set(block.type, (unknownBlockTypes.get(block.type) ?? 0) + 1);
			}
			return null;
	}
}

/** Extract tool_result blocks from a user record. */
export function extractToolResultBlocks(
	msg: RecordMessage | undefined,
	toolUseNames: Map<string, string>,
	timestamp?: string,
): ToolResultBlock[] {
	if (!msg) return [];

	const results: ToolResultBlock[] = [];
	if (Array.isArray(msg.content)) {
		for (const block of msg.content as ClaudeContentBlock[]) {
			if (block.type === BT_TOOL_RESULT && block.tool_use_id) {
				let resultContent = '';
				let images: ToolResultImage[] | undefined;

				if (typeof block.content === 'string') {
					resultContent = block.content;
				} else if (Array.isArray(block.content)) {
					const texts: string[] = [];
					for (const c of block.content as ToolResultContent[]) {
						if (c.type === 'image' && c.source?.data) {
							if (!images) images = [];
							images.push({
								mediaType: c.source.media_type ?? 'image/png',
								data: c.source.data,
							});
						} else {
							const t = c.text ?? c.content ?? '';
							if (t) texts.push(t);
						}
					}
					resultContent = texts.join('\n');
				}

				const result: ToolResultBlock = {
					type: 'tool_result',
					toolUseId: block.tool_use_id,
					toolName: toolUseNames.get(block.tool_use_id),
					content: resultContent,
					isError: block.is_error || false,
					timestamp,
				};
				if (images) result.images = images;
				results.push(result);
			}
		}
	}
	return results;
}

/** Detect interruption messages in user records. */
export function isInterruptionMessage(msg: RecordMessage | undefined): boolean {
	if (!msg) return false;
	const content = msg.content;
	if (typeof content === 'string') {
		return content.startsWith(PREFIX_INTERRUPTION);
	}
	if (Array.isArray(content)) {
		for (const block of content as ClaudeContentBlock[]) {
			if (block.type === BT_TEXT && block.text?.startsWith(PREFIX_INTERRUPTION)) {
				return true;
			}
		}
	}
	return false;
}

/** Extract the basename of a path without the .jsonl extension. */
export function basename(path: string): string {
	if (!path) return '';
	const parts = path.replace(/\\/g, '/').split('/');
	const last = parts[parts.length - 1] || '';
	return last.replace(/\.jsonl$/, '');
}
