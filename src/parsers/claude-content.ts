import type { ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, ToolResultImage } from '../types';
import { BT_TEXT, BT_THINKING, BT_TOOL_USE, BT_TOOL_RESULT, PREFIX_INTERRUPTION, RE_TOOL_USE_ERROR } from '../constants';

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
	unknownBlockTypes?: Map<string, { count: number; sample?: Record<string, unknown> }>,
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
				const existing = unknownBlockTypes.get(block.type);
				if (existing) {
					existing.count++;
				} else {
					const sample: Record<string, unknown> = { type: block.type, keys: Object.keys(block).filter(k => k !== 'type') };
					unknownBlockTypes.set(block.type, { count: 1, sample });
				}
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
		for (const block of msg.content) {
			if (block.type === BT_TOOL_RESULT && block.tool_use_id) {
				let resultContent = '';
				let images: ToolResultImage[] | undefined;

				if (typeof block.content === 'string') {
					resultContent = block.content;
				} else if (Array.isArray(block.content)) {
					const texts: string[] = [];
					for (const c of block.content) {
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

				// Strip <tool_use_error> XML wrapper — redundant with is_error flag
				if (block.is_error) {
					const m = RE_TOOL_USE_ERROR.exec(resultContent);
					if (m) resultContent = m[1].trim();
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
		for (const block of content) {
			if (block.type === BT_TEXT && block.text?.startsWith(PREFIX_INTERRUPTION)) {
				return true;
			}
		}
	}
	return false;
}