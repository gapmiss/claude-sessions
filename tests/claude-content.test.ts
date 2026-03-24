import { describe, it, expect } from 'vitest';
import { parseContentBlock, extractToolResultBlocks, isInterruptionMessage, basename } from '../src/parsers/claude-content';

// ─── parseContentBlock ─────────────────────────────────────────

describe('parseContentBlock', () => {
	const toolUseNames = new Map<string, string>();

	it('returns TextBlock for text type', () => {
		const result = parseContentBlock(
			{ type: 'text', text: 'hello' },
			toolUseNames, '2026-01-01T00:00:00Z',
		);
		expect(result).not.toBeNull();
		expect(result!.type).toBe('text');
		if (result!.type === 'text') {
			expect(result!.text).toBe('hello');
		}
	});

	it('returns null for empty text', () => {
		expect(parseContentBlock({ type: 'text', text: '' }, toolUseNames)).toBeNull();
	});

	it('returns null for whitespace-only text', () => {
		expect(parseContentBlock({ type: 'text', text: '   ' }, toolUseNames)).toBeNull();
	});

	it('returns ThinkingBlock for thinking type with content', () => {
		const result = parseContentBlock(
			{ type: 'thinking', thinking: 'deep thought' },
			toolUseNames,
		);
		expect(result).not.toBeNull();
		expect(result!.type).toBe('thinking');
	});

	it('returns null for thinking with only signature (encrypted)', () => {
		const result = parseContentBlock(
			{ type: 'thinking', thinking: '', signature: 'abc' },
			toolUseNames,
		);
		expect(result).toBeNull();
	});

	it('returns ToolUseBlock for tool_use type', () => {
		const names = new Map<string, string>();
		const result = parseContentBlock(
			{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
			names,
		);
		expect(result).not.toBeNull();
		expect(result!.type).toBe('tool_use');
		if (result!.type === 'tool_use') {
			expect(result!.name).toBe('Bash');
			expect(result!.id).toBe('tu_1');
		}
		// Should register the tool name for result attachment
		expect(names.get('tu_1')).toBe('Bash');
	});

	it('returns null for tool_use missing id', () => {
		expect(parseContentBlock(
			{ type: 'tool_use', name: 'Bash', input: {} },
			toolUseNames,
		)).toBeNull();
	});

	it('returns null for tool_use missing name', () => {
		expect(parseContentBlock(
			{ type: 'tool_use', id: 'tu_1', input: {} },
			toolUseNames,
		)).toBeNull();
	});

	it('tracks unknown block types', () => {
		const unknowns = new Map<string, number>();
		parseContentBlock({ type: 'new_block_type' }, toolUseNames, undefined, unknowns);
		expect(unknowns.get('new_block_type')).toBe(1);

		parseContentBlock({ type: 'new_block_type' }, toolUseNames, undefined, unknowns);
		expect(unknowns.get('new_block_type')).toBe(2);
	});

	it('preserves timestamp on content blocks', () => {
		const ts = '2026-01-01T12:00:00Z';
		const result = parseContentBlock(
			{ type: 'text', text: 'hello' },
			toolUseNames, ts,
		);
		expect(result!.timestamp).toBe(ts);
	});
});

// ─── extractToolResultBlocks ───────────────────────────────────

describe('extractToolResultBlocks', () => {
	it('extracts tool_result blocks from array content', () => {
		const names = new Map([['tu_1', 'Bash']]);
		const results = extractToolResultBlocks(
			{
				content: [
					{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
				],
			},
			names,
		);

		expect(results).toHaveLength(1);
		expect(results[0].toolUseId).toBe('tu_1');
		expect(results[0].toolName).toBe('Bash');
		expect(results[0].content).toBe('output');
	});

	it('returns empty for undefined message', () => {
		expect(extractToolResultBlocks(undefined, new Map())).toEqual([]);
	});

	it('returns empty for string content (user text)', () => {
		expect(extractToolResultBlocks(
			{ content: 'just text' },
			new Map(),
		)).toEqual([]);
	});

	it('skips tool_result blocks without tool_use_id', () => {
		const results = extractToolResultBlocks(
			{
				content: [
					{ type: 'tool_result', content: 'orphan' },
				],
			},
			new Map(),
		);
		expect(results).toHaveLength(0);
	});

	it('joins array content items', () => {
		const results = extractToolResultBlocks(
			{
				content: [{
					type: 'tool_result',
					tool_use_id: 'tu_1',
					content: [
						{ type: 'text', text: 'line 1' },
						{ type: 'text', text: 'line 2' },
					],
				}],
			},
			new Map(),
		);
		expect(results[0].content).toBe('line 1\nline 2');
	});
});

// ─── isInterruptionMessage ─────────────────────────────────────

describe('isInterruptionMessage', () => {
	it('detects string interruption', () => {
		expect(isInterruptionMessage({
			content: '[Request interrupted by user] some context',
		})).toBe(true);
	});

	it('detects array interruption', () => {
		expect(isInterruptionMessage({
			content: [
				{ type: 'text', text: '[Request interrupted by user] details' },
			],
		})).toBe(true);
	});

	it('rejects normal text', () => {
		expect(isInterruptionMessage({
			content: 'normal message',
		})).toBe(false);
	});

	it('rejects undefined message', () => {
		expect(isInterruptionMessage(undefined)).toBe(false);
	});
});

// ─── basename ──────────────────────────────────────────────────

describe('basename', () => {
	it('extracts filename without .jsonl extension', () => {
		expect(basename('/home/user/.claude/sessions/abc.jsonl')).toBe('abc');
	});

	it('handles Windows paths', () => {
		expect(basename('C:\\Users\\dev\\.claude\\sessions\\def.jsonl')).toBe('def');
	});

	it('returns empty string for null/undefined input', () => {
		expect(basename(null as unknown as string)).toBe('');
		expect(basename(undefined as unknown as string)).toBe('');
		expect(basename('')).toBe('');
	});

	it('preserves non-.jsonl extensions', () => {
		expect(basename('/path/to/file.json')).toBe('file.json');
	});
});
