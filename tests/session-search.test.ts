import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractSearchableContent, indexTextForBlock, searchTurns, searchTurnsRanked } from '../src/utils/session-search';
import type {
	Turn, ContentBlock,
	TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, ImageBlock,
	AnsiBlock, CompactionBlock, SlashCommandBlock, BashCommandBlock,
} from '../src/types';
import { jsonl, assistantText, assistantThinking, assistantToolUse, userText, userToolResult, fileHistorySnapshot, sidechainAssistant, metaAssistant, syntheticAssistant } from './fixtures';

/** Build a Turn fixture for searchTurns tests. */
function turn(index: number, role: 'user' | 'assistant', contentBlocks: ContentBlock[], timestamp?: string): Turn {
	return { index, role, contentBlocks, timestamp };
}

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

	it('skips custom-title records via quick check', () => {
		const line = JSON.stringify({ type: 'custom-title', customTitle: 'my-session', sessionId: 'abc' });
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips agent-name records via quick check', () => {
		const line = JSON.stringify({ type: 'agent-name', agentName: 'my-session', sessionId: 'abc' });
		expect(extractSearchableContent(line)).toBeNull();
	});

	it('skips last-prompt records via quick check', () => {
		const line = JSON.stringify({ type: 'last-prompt', prompt: 'test' });
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

// ── indexTextForBlock (Phase 2) ──────────────────────────────

describe('indexTextForBlock', () => {
	it('indexes text block as its text field', () => {
		const block: TextBlock = { type: 'text', text: 'Hello world' };
		expect(indexTextForBlock(block)).toBe('Hello world');
	});

	it('indexes thinking block as its thinking field', () => {
		const block: ThinkingBlock = { type: 'thinking', thinking: 'Let me think' };
		expect(indexTextForBlock(block)).toBe('Let me think');
	});

	it('indexes tool_use via extractToolInputText without the tool-name prefix', () => {
		const block: ToolUseBlock = {
			type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' },
		};
		expect(indexTextForBlock(block)).toBe('ls -la');
	});

	it('indexes Read tool_use as the file_path', () => {
		const block: ToolUseBlock = {
			type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/foo.ts' },
		};
		expect(indexTextForBlock(block)).toBe('/tmp/foo.ts');
	});

	it('indexes tool_result content as-is for non-Read tools', () => {
		const block: ToolResultBlock = {
			type: 'tool_result', toolUseId: 't1', toolName: 'Bash',
			content: 'total 24\ndrwxr-xr-x',
			isError: false,
		};
		expect(indexTextForBlock(block)).toBe('total 24\ndrwxr-xr-x');
	});

	it('strips line numbers from Read tool_result (arrow and tab separators)', () => {
		const block: ToolResultBlock = {
			type: 'tool_result', toolUseId: 't1', toolName: 'Read',
			content: '1\u2192first line\n2\u2192second line\n3\tthird',
			isError: false,
		};
		expect(indexTextForBlock(block)).toBe('first line\nsecond line\nthird');
	});

	it('keeps Read tool_result raw when isError (matches renderer branch)', () => {
		const block: ToolResultBlock = {
			type: 'tool_result', toolUseId: 't1', toolName: 'Read',
			content: 'ENOENT: no such file /tmp/missing',
			isError: true,
		};
		expect(indexTextForBlock(block)).toBe('ENOENT: no such file /tmp/missing');
	});

	it('strips <system-reminder> tags from Read tool_result', () => {
		const block: ToolResultBlock = {
			type: 'tool_result', toolUseId: 't1', toolName: 'Read',
			content: '1\u2192actual content<system-reminder>hidden</system-reminder>',
			isError: false,
		};
		expect(indexTextForBlock(block)).toBe('actual content');
	});

	it('indexes slash_command as body text (BUGS.md #1 skill-expansion search)', () => {
		const block: SlashCommandBlock = {
			type: 'slash_command',
			commandName: '/rename',
			text: 'Rename session to miscellaneous-fixes',
		};
		expect(indexTextForBlock(block)).toBe('Rename session to miscellaneous-fixes');
	});

	it('indexes bash_command as command + stdout + stderr joined by newlines', () => {
		const block: BashCommandBlock = {
			type: 'bash_command',
			command: 'ls -la',
			stdout: 'total 24',
			stderr: '',
		};
		expect(indexTextForBlock(block)).toBe('ls -la\ntotal 24');
	});

	it('skips empty fields in bash_command concatenation', () => {
		const block: BashCommandBlock = {
			type: 'bash_command',
			command: 'pwd',
			stdout: '',
			stderr: '',
		};
		expect(indexTextForBlock(block)).toBe('pwd');
	});

	it('includes stderr after stdout in bash_command', () => {
		const block: BashCommandBlock = {
			type: 'bash_command',
			command: 'cat missing',
			stdout: '',
			stderr: 'No such file',
		};
		expect(indexTextForBlock(block)).toBe('cat missing\nNo such file');
	});

	it('strips ANSI escape codes from bash stdout and stderr', () => {
		const block: BashCommandBlock = {
			type: 'bash_command',
			command: 'ls',
			stdout: '\u001b[31mred\u001b[0m text',
			stderr: '\u001b[33mwarn\u001b[0m',
		};
		expect(indexTextForBlock(block)).toBe('ls\nred text\nwarn');
	});

	it('strips ANSI escape codes from ansi block', () => {
		const block: AnsiBlock = {
			type: 'ansi',
			label: 'output',
			text: '\u001b[32mgreen\u001b[0m',
		};
		expect(indexTextForBlock(block)).toBe('green');
	});

	it('indexes compaction summary', () => {
		const block: CompactionBlock = { type: 'compaction', summary: 'Previous conversation summary' };
		expect(indexTextForBlock(block)).toBe('Previous conversation summary');
	});

	it('indexes compaction with no summary as empty string', () => {
		const block: CompactionBlock = { type: 'compaction' };
		expect(indexTextForBlock(block)).toBe('');
	});

	it('indexes image block as empty string (not searchable)', () => {
		const block: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'base64' };
		expect(indexTextForBlock(block)).toBe('');
	});
});

// ── searchTurns (Phase 2) ────────────────────────────────────

describe('searchTurns', () => {
	it('returns empty for empty query', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'hello' }])];
		const result = searchTurns(turns, { text: '' });
		expect(result.matches).toEqual([]);
		expect(result.totalMatches).toBe(0);
	});

	it('finds a match in a text block with precise coordinates', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'Hello world, hello again' }])];
		const result = searchTurns(turns, { text: 'hello' });
		expect(result.totalMatches).toBe(2);
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]).toMatchObject({
			turnIndex: 0, role: 'assistant', blockType: 'text',
			contentBlockIndex: 0, charOffset: 0, charLength: 5,
			matchText: 'Hello',
		});
		expect(result.matches[1]).toMatchObject({
			turnIndex: 0, contentBlockIndex: 0, charOffset: 13, charLength: 5,
			matchText: 'hello',
		});
	});

	it('case-sensitive search respects case', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'Hello world' }])];
		expect(searchTurns(turns, { text: 'hello', caseSensitive: true }).matches).toHaveLength(0);
		expect(searchTurns(turns, { text: 'Hello', caseSensitive: true }).matches).toHaveLength(1);
	});

	it('finds matches in thinking blocks', () => {
		const turns = [turn(0, 'assistant', [
			{ type: 'thinking', thinking: 'Let me think about the brew problem' },
		])];
		const result = searchTurns(turns, { text: 'brew' });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].blockType).toBe('thinking');
	});

	it('finds matches in tool_use input (BUGS.md #4 adjacent)', () => {
		const turns = [turn(0, 'assistant', [
			{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'brew install foo' } },
		])];
		const result = searchTurns(turns, { text: 'brew' });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			blockType: 'tool_use', toolName: 'Bash', charOffset: 0, charLength: 4,
		});
	});

	it('finds matches inside tool_result content (BUGS.md #4)', () => {
		const turns = [turn(0, 'assistant', [
			{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/f.ts' } },
			{
				type: 'tool_result', toolUseId: 't1', toolName: 'Read', isError: false,
				content: '1\u2192export function inputHandler(input: string) {\n2\u2192  return input.trim();\n3\u2192}',
			},
		])];
		const result = searchTurns(turns, { text: 'input' });
		// 3 occurrences of "input" in the cleaned indexed text (after line-number strip)
		expect(result.totalMatches).toBe(3);
		const inToolResult = result.matches.filter(m => m.blockType === 'tool_result');
		expect(inToolResult).toHaveLength(3);
		expect(inToolResult.every(m => m.contentBlockIndex === 1)).toBe(true);
		// Each match at a distinct offset (regression guard for BUGS.md #2 "same word" pattern)
		const offsets = new Set(inToolResult.map(m => m.charOffset));
		expect(offsets.size).toBe(3);
	});

	it('finds slash_command body text (BUGS.md #1 regression)', () => {
		const turns = [turn(0, 'user', [
			{ type: 'text', text: '/rename' },
			{
				type: 'slash_command',
				commandName: '/rename',
				text: 'Rename session to miscellaneous-fixes',
			},
		])];
		const result = searchTurns(turns, { text: 'miscellaneous' });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			blockType: 'slash_command',
			contentBlockIndex: 1,
			role: 'user',
		});
	});

	it('finds matches in bash_command across command + stdout', () => {
		const turns = [turn(0, 'user', [
			{ type: 'bash_command', command: 'echo brew', stdout: 'brew install', stderr: '' },
		])];
		const result = searchTurns(turns, { text: 'brew' });
		expect(result.totalMatches).toBe(2);
		expect(result.matches[0].charOffset).toBe(5);      // in "echo brew"
		expect(result.matches[1].charOffset).toBe(10);     // in "...\nbrew install" (after newline)
	});

	it('every match in the same turn has a distinct charOffset (BUGS.md #2 regression)', () => {
		const turns = [turn(0, 'assistant', [
			{ type: 'text', text: 'brew brew brew brew brew' },
		])];
		const result = searchTurns(turns, { text: 'brew' });
		expect(result.matches).toHaveLength(5);
		const offsets = result.matches.map(m => m.charOffset);
		expect(offsets).toEqual([0, 5, 10, 15, 20]);
	});

	it('uses turn.index for turnIndex, not array position', () => {
		const turns = [
			turn(7, 'assistant', [{ type: 'text', text: 'needle here' }]),
			turn(12, 'user', [{ type: 'text', text: 'more needle' }]),
		];
		const result = searchTurns(turns, { text: 'needle' });
		expect(result.matches.map(m => m.turnIndex)).toEqual([7, 12]);
	});

	it('respects roleFilter=user', () => {
		const turns = [
			turn(0, 'user', [{ type: 'text', text: 'needle in user turn' }]),
			turn(1, 'assistant', [{ type: 'text', text: 'needle in assistant turn' }]),
		];
		const result = searchTurns(turns, { text: 'needle', roleFilter: 'user' });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].role).toBe('user');
	});

	it('respects roleFilter=assistant', () => {
		const turns = [
			turn(0, 'user', [{ type: 'text', text: 'needle in user turn' }]),
			turn(1, 'assistant', [{ type: 'text', text: 'needle in assistant turn' }]),
		];
		const result = searchTurns(turns, { text: 'needle', roleFilter: 'assistant' });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].role).toBe('assistant');
	});

	it('caps matches at maxMatches but keeps totalMatches accurate', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'a a a a a a a a a a' }])];
		const result = searchTurns(turns, { text: 'a' }, 3);
		expect(result.matches).toHaveLength(3);
		expect(result.totalMatches).toBe(10);
	});

	it('produces contextBefore / contextAfter around each match', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'alpha brew omega' }])];
		const result = searchTurns(turns, { text: 'brew' });
		expect(result.matches[0].contextBefore).toBe('alpha ');
		expect(result.matches[0].contextAfter).toBe(' omega');
	});

	it('skips blocks with empty indexed text (e.g. image, empty compaction)', () => {
		const turns = [turn(0, 'assistant', [
			{ type: 'text', text: 'aaa target aaa' },
			{ type: 'image', mediaType: 'image/png', data: 'b64' },
			{ type: 'compaction' },
		])];
		const result = searchTurns(turns, { text: 'target' });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].contentBlockIndex).toBe(0);
	});
});

// ── searchTurnsRanked (Phase 2) ──────────────────────────────

describe('searchTurnsRanked', () => {
	it('returns empty for empty query', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'hello' }])];
		const result = searchTurnsRanked(turns, { text: '' });
		expect(result.matches).toEqual([]);
	});

	it('returns matches with coordinate fields and BM25 scores', () => {
		const turns = [
			turn(0, 'assistant', [{ type: 'text', text: 'a random unrelated sentence about cats' }]),
			turn(1, 'assistant', [{ type: 'text', text: 'the needle is here, needle needle' }]),
		];
		const result = searchTurnsRanked(turns, { text: 'needle' });
		expect(result.totalMatches).toBe(3);
		expect(result.matches.every(m => typeof m.score === 'number')).toBe(true);
		expect(result.matches.every(m => typeof m.charOffset === 'number')).toBe(true);
	});

	it('ranks the block with more matches higher', () => {
		const turns = [
			turn(0, 'assistant', [{ type: 'text', text: 'needle once' }]),
			turn(1, 'assistant', [{ type: 'text', text: 'needle needle needle packed tight' }]),
		];
		const result = searchTurnsRanked(turns, { text: 'needle' });
		// First match should be from turn 1 (higher BM25 score due to term frequency)
		expect(result.matches[0].turnIndex).toBe(1);
	});

	it('caps matches at maxMatches after ranking', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'x x x x x x x' }])];
		const result = searchTurnsRanked(turns, { text: 'x' }, 2);
		expect(result.matches).toHaveLength(2);
		expect(result.totalMatches).toBe(7);
	});

	it('ranked matches retain precise coordinates', () => {
		const turns = [turn(0, 'assistant', [{ type: 'text', text: 'alpha brew omega brew' }])];
		const result = searchTurnsRanked(turns, { text: 'brew' });
		const offsets = result.matches.map(m => m.charOffset).sort((a, b) => a - b);
		expect(offsets).toEqual([6, 17]);
	});
});
