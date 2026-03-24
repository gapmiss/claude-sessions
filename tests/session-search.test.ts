import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractSearchableContent } from '../src/utils/session-search';
import { jsonl, assistantText, assistantThinking, assistantToolUse, userText, userToolResult, fileHistorySnapshot, sidechainAssistant, metaAssistant, syntheticAssistant } from './fixtures';

// ── extractSearchableContent ─────────────────────────────────

describe('extractSearchableContent', () => {
	it('extracts assistant text', () => {
		const line = JSON.stringify(assistantText('Hello world'));
		const result = extractSearchableContent(line);
		expect(result).not.toBeNull();
		expect(result!.role).toBe('assistant');
		expect(result!.blockType).toBe('text');
		expect(result!.text).toBe('Hello world');
	});

	it('extracts assistant thinking', () => {
		const line = JSON.stringify(assistantThinking('Let me think about this'));
		const result = extractSearchableContent(line);
		expect(result).not.toBeNull();
		expect(result!.role).toBe('assistant');
		expect(result!.blockType).toBe('thinking');
		expect(result!.text).toBe('Let me think about this');
	});

	it('extracts assistant tool_use with name and input', () => {
		const line = JSON.stringify(assistantToolUse('Bash', 'tool-1', { command: 'ls -la' }));
		const result = extractSearchableContent(line);
		expect(result).not.toBeNull();
		expect(result!.role).toBe('assistant');
		expect(result!.blockType).toBe('tool_use');
		expect(result!.toolName).toBe('Bash');
		expect(result!.text).toContain('Bash');
		expect(result!.text).toContain('ls -la');
	});

	it('extracts user text', () => {
		const line = JSON.stringify(userText('Fix the bug'));
		const result = extractSearchableContent(line);
		expect(result).not.toBeNull();
		expect(result!.role).toBe('user');
		expect(result!.blockType).toBe('text');
		expect(result!.text).toBe('Fix the bug');
	});

	it('extracts tool result content from user records', () => {
		const line = JSON.stringify(userToolResult([
			{ toolUseId: 'tool-1', content: 'file content here' },
		]));
		const result = extractSearchableContent(line);
		expect(result).not.toBeNull();
		expect(result!.blockType).toBe('tool_result');
		expect(result!.text).toContain('file content here');
	});

	it('skips file-history-snapshot records', () => {
		const line = JSON.stringify(fileHistorySnapshot());
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips sidechain records', () => {
		const line = JSON.stringify(sidechainAssistant('hidden text'));
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips meta records', () => {
		const line = JSON.stringify(metaAssistant('meta text'));
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips synthetic model records', () => {
		const line = JSON.stringify(syntheticAssistant('synthetic text'));
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips empty lines', () => {
		expect(extractSearchableContent('')).toBeNull();
		expect(extractSearchableContent('   ')).toBeNull();
	});

	it('skips malformed JSON', () => {
		expect(extractSearchableContent('{not valid json')).toBeNull();
	});

	it('skips progress records via quick check', () => {
		const line = JSON.stringify({ type: 'progress', data: { type: 'hook_progress' } });
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips queue-operation records via quick check', () => {
		const line = JSON.stringify({ type: 'queue-operation', data: {} });
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('preserves timestamp', () => {
		const ts = '2026-01-15T10:30:00.000Z';
		const line = JSON.stringify(assistantText('test', { timestamp: ts }));
		const result = extractSearchableContent(line);
		expect(result!.timestamp).toBe(ts);
	});

	it('skips encrypted thinking (empty thinking field)', () => {
		const line = JSON.stringify({
			type: 'assistant',
			uuid: 'test',
			timestamp: '2026-01-01T00:00:00.000Z',
			message: {
				role: 'assistant',
				model: 'claude-sonnet-4-20250514',
				content: [{ type: 'thinking', thinking: '', signature: 'abc123' }],
			},
		});
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('concatenates multiple tool_result contents', () => {
		const line = JSON.stringify(userToolResult([
			{ toolUseId: 'tool-1', content: 'first result' },
			{ toolUseId: 'tool-2', content: 'second result' },
		]));
		const result = extractSearchableContent(line);
		expect(result).not.toBeNull();
		expect(result!.text).toContain('first result');
		expect(result!.text).toContain('second result');
	});

	it('returns null for records without message', () => {
		const line = JSON.stringify({ type: 'assistant', uuid: 'test' });
		expect(extractSearchableContent(line)).toBeNull();
	});
});
