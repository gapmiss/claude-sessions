import { describe, it, expect } from 'vitest';
import { ClaudeParser } from '../src/parsers/claude-parser';
import {
	jsonl, assistantText, assistantThinking, assistantEncryptedThinking,
	assistantToolUse, userText, userToolResult,
	fileHistorySnapshot, sidechainAssistant, metaAssistant,
	syntheticAssistant, userInterruption, userSlashCommand, metaSkillExpansion,
	userBashInput, userBashOutput, userBashCaveat,
} from './fixtures';

function parse(content: string, filePath = '/test/session.jsonl') {
	return new ClaudeParser().parse(content, filePath);
}

// ─── Format Detection ──────────────────────────────────────────

describe('canParse', () => {
	const parser = new ClaudeParser();

	it('detects Claude JSONL by assistant record with message.role', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
		});
		expect(parser.canParse([line])).toBe(true);
	});

	it('detects Claude JSONL by user record with message.role', () => {
		const line = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'hello' },
		});
		expect(parser.canParse([line])).toBe(true);
	});

	it('detects Claude JSONL by sessionId field', () => {
		const line = JSON.stringify({
			type: 'file-history-snapshot',
			sessionId: 'abc-123',
		});
		expect(parser.canParse([line])).toBe(true);
	});

	it('rejects non-Claude JSONL', () => {
		const line = JSON.stringify({ type: 'other', data: 123 });
		expect(parser.canParse([line])).toBe(false);
	});

	it('rejects empty input', () => {
		expect(parser.canParse([])).toBe(false);
	});
});

// ─── Basic Turn Merging ────────────────────────────────────────

describe('turn merging', () => {
	it('merges consecutive assistant records into a single turn', () => {
		const session = parse(jsonl(
			assistantThinking('let me think...'),
			assistantText('here is my answer'),
			assistantToolUse('Read', 'tu_1', { file_path: '/foo.ts' }),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].role).toBe('assistant');
		expect(session.turns[0].contentBlocks).toHaveLength(3);
		expect(session.turns[0].contentBlocks[0].type).toBe('thinking');
		expect(session.turns[0].contentBlocks[1].type).toBe('text');
		expect(session.turns[0].contentBlocks[2].type).toBe('tool_use');
	});

	it('flushes assistant turn when user text arrives', () => {
		const session = parse(jsonl(
			assistantText('response 1'),
			userText('question 2'),
			assistantText('response 2'),
		));

		expect(session.turns).toHaveLength(3);
		expect(session.turns[0].role).toBe('assistant');
		expect(session.turns[1].role).toBe('user');
		expect(session.turns[2].role).toBe('assistant');
	});

	it('creates a user turn from user text content', () => {
		const session = parse(jsonl(
			userText('hello world'),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].role).toBe('user');
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('text');
		if (block.type === 'text') {
			expect(block.text).toBe('hello world');
		}
	});
});

// ─── Tool Result Attachment ────────────────────────────────────

describe('tool result attachment', () => {
	it('attaches tool results to preceding assistant turn', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'ls' }),
			userToolResult([{ toolUseId: 'tu_1', content: 'file1.ts\nfile2.ts' }]),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].role).toBe('assistant');
		expect(session.turns[0].contentBlocks).toHaveLength(2);
		expect(session.turns[0].contentBlocks[0].type).toBe('tool_use');
		expect(session.turns[0].contentBlocks[1].type).toBe('tool_result');
	});

	it('does not create a user turn for tool-result-only user records', () => {
		const session = parse(jsonl(
			userText('do something'),
			assistantToolUse('Read', 'tu_1', { file_path: '/a.ts' }),
			userToolResult([{ toolUseId: 'tu_1', content: 'file content' }]),
			assistantText('done'),
		));

		// user, assistant (tool_use + tool_result + text merged)
		expect(session.turns).toHaveLength(2);
		expect(session.turns[0].role).toBe('user');
		expect(session.turns[1].role).toBe('assistant');
		expect(session.turns[1].contentBlocks).toHaveLength(3);
	});

	it('preserves tool name on tool_result via toolUseNames map', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'echo hi' }),
			userToolResult([{ toolUseId: 'tu_1', content: 'hi' }]),
		));

		const result = session.turns[0].contentBlocks[1];
		expect(result.type).toBe('tool_result');
		if (result.type === 'tool_result') {
			expect(result.toolName).toBe('Bash');
		}
	});

	it('marks error results with isError', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'bad' }),
			userToolResult([{ toolUseId: 'tu_1', content: 'error!', isError: true }]),
		));

		const result = session.turns[0].contentBlocks[1];
		if (result.type === 'tool_result') {
			expect(result.isError).toBe(true);
		}
	});
});

// ─── Deduplication ─────────────────────────────────────────────

describe('deduplication', () => {
	it('keeps the last record when uuid is duplicated (streaming)', () => {
		const uuid = crypto.randomUUID();
		const session = parse(jsonl(
			assistantText('partial...', { uuid }),
			assistantText('complete answer', { uuid }),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].contentBlocks).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'text') {
			expect(block.text).toBe('complete answer');
		}
	});

	it('does not deduplicate records with different uuids', () => {
		const session = parse(jsonl(
			assistantText('first'),
			assistantText('second'),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].contentBlocks).toHaveLength(2);
	});
});

// ─── Record Filtering ──────────────────────────────────────────

describe('record filtering', () => {
	it('skips file-history-snapshot records', () => {
		const session = parse(jsonl(
			fileHistorySnapshot(),
			assistantText('hello'),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].contentBlocks[0].type).toBe('text');
	});

	it('skips isSidechain records by default', () => {
		const session = parse(jsonl(
			sidechainAssistant('sidechain text'),
			assistantText('main text'),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'text') {
			expect(block.text).toBe('main text');
		}
	});

	it('includes isSidechain records when allowSidechain is true', () => {
		const parser = new ClaudeParser({ allowSidechain: true });
		const session = parser.parse(jsonl(
			sidechainAssistant('sidechain text'),
		), '/test/session.jsonl');

		expect(session.turns).toHaveLength(1);
	});

	it('skips isMeta assistant records', () => {
		const session = parse(jsonl(
			metaAssistant('meta content'),
			assistantText('real content'),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'text') {
			expect(block.text).toBe('real content');
		}
	});

	it('skips synthetic model records', () => {
		const session = parse(jsonl(
			syntheticAssistant('synthetic'),
			assistantText('real'),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'text') {
			expect(block.text).toBe('real');
		}
	});

	it('skips encrypted thinking blocks (signature only)', () => {
		const session = parse(jsonl(
			assistantEncryptedThinking(),
			assistantText('visible text'),
		));

		expect(session.turns).toHaveLength(1);
		// Only the text block should remain (encrypted thinking produces null)
		expect(session.turns[0].contentBlocks).toHaveLength(1);
		expect(session.turns[0].contentBlocks[0].type).toBe('text');
	});
});

// ─── Token Usage ───────────────────────────────────────────────

describe('token usage', () => {
	it('extracts token counts from assistant records', () => {
		const session = parse(jsonl(
			assistantText('hello', {
				msgId: 'msg_1',
				usage: {
					input_tokens: 10,
					output_tokens: 50,
					cache_read_input_tokens: 1000,
					cache_creation_input_tokens: 200,
				},
			}),
		));

		expect(session.stats.inputTokens).toBe(10);
		expect(session.stats.outputTokens).toBe(50);
		expect(session.stats.cacheReadTokens).toBe(1000);
		expect(session.stats.cacheCreationTokens).toBe(200);
		expect(session.stats.totalTokens).toBe(1260);
	});

	it('deduplicates tokens by message ID (keeps max)', () => {
		const session = parse(jsonl(
			assistantText('partial', {
				uuid: 'uuid-1',
				msgId: 'msg_1',
				usage: { input_tokens: 10, output_tokens: 20 },
			}),
			assistantText('complete', {
				uuid: 'uuid-2',
				msgId: 'msg_1',
				usage: { input_tokens: 10, output_tokens: 80 },
			}),
		));

		// Should keep max of each field, not sum
		expect(session.stats.inputTokens).toBe(10);
		expect(session.stats.outputTokens).toBe(80);
	});

	it('sums tokens across different messages', () => {
		const session = parse(jsonl(
			assistantText('first', {
				msgId: 'msg_1',
				usage: { input_tokens: 5, output_tokens: 30 },
			}),
			userText('question'),
			assistantText('second', {
				msgId: 'msg_2',
				usage: { input_tokens: 5, output_tokens: 40 },
			}),
		));

		expect(session.stats.inputTokens).toBe(10);
		expect(session.stats.outputTokens).toBe(70);
	});

	it('uses fallback key when message.id is absent', () => {
		// Records without message.id should still have their tokens counted
		const rec = assistantText('no id', {
			uuid: 'uuid-no-id',
			usage: { input_tokens: 5, output_tokens: 25 },
		});
		// Remove the message id
		delete (rec.message as Record<string, unknown>).id;

		const session = parse(jsonl(rec));
		expect(session.stats.outputTokens).toBe(25);
	});
});

// ─── Timestamps & Duration ─────────────────────────────────────

describe('timestamps and duration', () => {
	it('computes duration from first to last timestamp', () => {
		const session = parse(jsonl(
			assistantText('start', { timestamp: '2026-01-01T00:00:00.000Z' }),
			userText('middle', { timestamp: '2026-01-01T00:05:00.000Z' }),
			assistantText('end', { timestamp: '2026-01-01T00:10:00.000Z' }),
		));

		expect(session.stats.durationMs).toBe(10 * 60 * 1000);
	});

	it('handles NaN timestamps gracefully (duration stays 0)', () => {
		const session = parse(jsonl(
			assistantText('start', { timestamp: 'not-a-date' }),
			assistantText('end', { timestamp: 'also-not-a-date' }),
		));

		expect(session.stats.durationMs).toBe(0);
		expect(Number.isNaN(session.stats.durationMs)).toBe(false);
	});

	it('preserves per-block timestamps', () => {
		const ts = '2026-01-01T12:30:00.000Z';
		const session = parse(jsonl(
			assistantText('hello', { timestamp: ts }),
		));

		expect(session.turns[0].contentBlocks[0].timestamp).toBe(ts);
	});
});

// ─── Metadata Extraction ───────────────────────────────────────

describe('metadata extraction', () => {
	it('extracts sessionId, cwd, version, and branch from first record', () => {
		const session = parse(jsonl(
			userText('hi', {
				sessionId: 'sess-abc',
				cwd: '/home/user/project',
			}),
			assistantText('hello'),
		));

		expect(session.metadata.id).toBe('sess-abc');
		expect(session.metadata.cwd).toBe('/home/user/project');
	});

	it('extracts model from assistant record', () => {
		const session = parse(jsonl(
			assistantText('hello', { model: 'claude-opus-4-20250514' }),
		));

		expect(session.metadata.model).toBe('claude-opus-4-20250514');
	});

	it('extracts customTitle from custom-title record', () => {
		const session = parse(jsonl(
			userText('hi'),
			{ type: 'custom-title', customTitle: 'my-session-name', sessionId: 'abc' },
			assistantText('hello'),
		));

		expect(session.metadata.customTitle).toBe('my-session-name');
	});

	it('uses last customTitle when multiple renames occur', () => {
		const session = parse(jsonl(
			userText('hi'),
			{ type: 'custom-title', customTitle: 'first-name', sessionId: 'abc' },
			assistantText('hello'),
			{ type: 'custom-title', customTitle: 'second-name', sessionId: 'abc' },
			userText('more'),
			{ type: 'custom-title', customTitle: 'final-name', sessionId: 'abc' },
		));

		expect(session.metadata.customTitle).toBe('final-name');
	});

	it('leaves customTitle undefined when no custom-title record exists', () => {
		const session = parse(jsonl(
			userText('hi'),
			assistantText('hello'),
		));

		expect(session.metadata.customTitle).toBeUndefined();
	});
});

// ─── Orphaned / Pending Tool Calls ─────────────────────────────

describe('orphaned and pending tool calls', () => {
	it('marks last-turn tool calls without results as pending', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'long-running' }),
		));

		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'tool_use') {
			expect(block.isPending).toBe(true);
			expect(block.isOrphaned).toBeUndefined();
		}
	});

	it('marks mid-session tool calls without results as orphaned', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'interrupted' }),
			userText('never mind'),
			assistantText('ok, moving on'),
		));

		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'tool_use') {
			expect(block.isOrphaned).toBe(true);
			expect(block.isPending).toBeUndefined();
		}
	});

	it('does not mark tool calls that have results', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'ls' }),
			userToolResult([{ toolUseId: 'tu_1', content: 'files' }]),
		));

		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'tool_use') {
			expect(block.isPending).toBeUndefined();
			expect(block.isOrphaned).toBeUndefined();
		}
	});
});

// ─── Interruption Handling ─────────────────────────────────────

describe('interruption handling', () => {
	it('attaches interruption message to current assistant turn', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'slow' }),
			userInterruption(),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].role).toBe('assistant');
		const blocks = session.turns[0].contentBlocks;
		const last = blocks[blocks.length - 1];
		expect(last.type).toBe('text');
		if (last.type === 'text') {
			expect(last.text).toBe('*Request interrupted by user*');
		}
	});

	it('does not create a separate user turn for interruption', () => {
		const session = parse(jsonl(
			assistantText('working...'),
			userInterruption(),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].role).toBe('assistant');
	});
});

// ─── Session Stats ─────────────────────────────────────────────

describe('session stats', () => {
	it('counts user and assistant turns', () => {
		const session = parse(jsonl(
			userText('q1'),
			assistantText('a1'),
			userText('q2'),
			assistantText('a2'),
		));

		expect(session.stats.userTurns).toBe(2);
		expect(session.stats.assistantTurns).toBe(2);
	});

	it('counts tool usage by name', () => {
		const session = parse(jsonl(
			assistantToolUse('Bash', 'tu_1', { command: 'ls' }),
			userToolResult([{ toolUseId: 'tu_1', content: 'ok' }]),
			assistantToolUse('Read', 'tu_2', { file_path: '/a.ts' }),
			userToolResult([{ toolUseId: 'tu_2', content: 'ok' }]),
			assistantToolUse('Bash', 'tu_3', { command: 'cat' }),
			userToolResult([{ toolUseId: 'tu_3', content: 'ok' }]),
		));

		expect(session.stats.toolUseCounts['Bash']).toBe(2);
		expect(session.stats.toolUseCounts['Read']).toBe(1);
	});
});

// ─── Edge Cases ────────────────────────────────────────────────

describe('edge cases', () => {
	it('handles empty input', () => {
		const session = parse('');
		expect(session.turns).toHaveLength(0);
	});

	it('handles malformed JSON lines gracefully', () => {
		const session = parse(jsonl(
			assistantText('valid'),
		) + '\n{broken json\nnot json at all');

		expect(session.turns).toHaveLength(1);
	});

	it('handles assistant record with empty text (skipped)', () => {
		const session = parse(jsonl(
			assistantText(''),
			assistantText('real text'),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].contentBlocks).toHaveLength(1);
	});

	it('handles whitespace-only text blocks (skipped)', () => {
		const session = parse(jsonl(
			assistantText('   \n\t  '),
			assistantText('actual content'),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		if (block.type === 'text') {
			expect(block.text).toBe('actual content');
		}
	});

	it('extracts project name from file path', () => {
		const session = parse(
			jsonl(assistantText('hi')),
			'/home/user/.claude/projects/-home-user-myproject/abc.jsonl',
		);

		expect(session.metadata.project).toBeDefined();
	});
});

// ─── Content Block Parsing (claude-content.ts) ─────────────────

describe('content block types', () => {
	it('parses text blocks', () => {
		const session = parse(jsonl(assistantText('hello world')));
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('text');
		if (block.type === 'text') {
			expect(block.text).toBe('hello world');
		}
	});

	it('parses thinking blocks', () => {
		const session = parse(jsonl(assistantThinking('deep thought')));
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('thinking');
		if (block.type === 'thinking') {
			expect(block.thinking).toBe('deep thought');
		}
	});

	it('parses tool_use blocks with input', () => {
		const session = parse(jsonl(
			assistantToolUse('Edit', 'tu_1', {
				file_path: '/foo.ts',
				old_string: 'a',
				new_string: 'b',
			}),
		));

		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('tool_use');
		if (block.type === 'tool_use') {
			expect(block.name).toBe('Edit');
			expect(block.id).toBe('tu_1');
			expect(block.input).toEqual({
				file_path: '/foo.ts',
				old_string: 'a',
				new_string: 'b',
			});
		}
	});
});

// ─── Slash Command / Skill Expansion ────────────────────────────

describe('slash command parsing', () => {
	it('detects skill command with <command-message> prefix and colon in name', () => {
		const session = parse(jsonl(
			userSlashCommand('/wrap:wrap'),
			assistantText('response'),
		));

		expect(session.turns).toHaveLength(2);
		const userBlock = session.turns[0].contentBlocks[0];
		expect(userBlock.type).toBe('text');
		if (userBlock.type === 'text') {
			// Display name strips colon suffix: /wrap:wrap → /wrap
			expect(userBlock.text).toBe('/wrap');
		}
	});

	it('captures isMeta skill expansion as slash_command block', () => {
		const session = parse(jsonl(
			userSlashCommand('/wrap:wrap'),
			metaSkillExpansion('Capture session state and write to CLAUDE.md.\n\n## Instructions\n\n1. Read CLAUDE.md'),
			assistantText('Done.'),
		));

		expect(session.turns).toHaveLength(2); // user + assistant
		const userTurn = session.turns[0];
		expect(userTurn.contentBlocks).toHaveLength(2); // text + slash_command
		expect(userTurn.contentBlocks[0].type).toBe('text');
		expect(userTurn.contentBlocks[1].type).toBe('slash_command');
		if (userTurn.contentBlocks[1].type === 'slash_command') {
			expect(userTurn.contentBlocks[1].commandName).toBe('/wrap:wrap');
			expect(userTurn.contentBlocks[1].text).toContain('Capture session state');
		}
	});

	it('strips system-reminder tags from skill expansion text', () => {
		const session = parse(jsonl(
			userSlashCommand('/test:run'),
			metaSkillExpansion('Run the tests.\n<system-reminder>internal data</system-reminder>\nDone.'),
			assistantText('OK'),
		));

		const slashBlock = session.turns[0].contentBlocks[1];
		if (slashBlock.type === 'slash_command') {
			expect(slashBlock.text).not.toContain('system-reminder');
			expect(slashBlock.text).toContain('Run the tests.');
		}
	});

	it('skips isMeta user records without a pending slash command', () => {
		const session = parse(jsonl(
			userText('hello'),
			metaSkillExpansion('orphaned expansion'),
			assistantText('world'),
		));

		// The orphaned isMeta user record should be skipped
		expect(session.turns).toHaveLength(2); // user + assistant
		expect(session.turns[0].contentBlocks).toHaveLength(1);
		expect(session.turns[0].contentBlocks[0].type).toBe('text');
	});

	it('handles built-in slash commands without colon', () => {
		const session = parse(jsonl(
			userText('<command-name>/compact</command-name>'),
			assistantText('compacted'),
		));

		expect(session.turns).toHaveLength(2);
		const userBlock = session.turns[0].contentBlocks[0];
		if (userBlock.type === 'text') {
			expect(userBlock.text).toBe('/compact');
		}
	});
});

describe('user bash command consolidation', () => {
	it('consolidates bash-input and bash-stdout into a single BashCommandBlock', () => {
		const session = parse(jsonl(
			userBashInput('./copy-to-vaults.sh'),
			userBashOutput('Plugin copied to vaults.'),
		));

		expect(session.turns).toHaveLength(1);
		expect(session.turns[0].role).toBe('user');
		expect(session.turns[0].contentBlocks).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('bash_command');
		if (block.type === 'bash_command') {
			expect(block.command).toBe('./copy-to-vaults.sh');
			expect(block.stdout).toBe('Plugin copied to vaults.');
			expect(block.stderr).toBe('');
		}
	});

	it('filters isMeta caveat and still consolidates remaining records', () => {
		const session = parse(jsonl(
			userBashCaveat(),
			userBashInput('./build.sh'),
			userBashOutput('Build complete.'),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('bash_command');
		if (block.type === 'bash_command') {
			expect(block.command).toBe('./build.sh');
			expect(block.stdout).toBe('Build complete.');
		}
	});

	it('captures stderr content', () => {
		const session = parse(jsonl(
			userBashInput('npm test'),
			userBashOutput('', 'Error: test failed'),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('bash_command');
		if (block.type === 'bash_command') {
			expect(block.stdout).toBe('');
			expect(block.stderr).toBe('Error: test failed');
		}
	});

	it('handles empty stdout and empty stderr', () => {
		const session = parse(jsonl(
			userBashInput('mkdir test'),
			userBashOutput('', ''),
		));

		expect(session.turns).toHaveLength(1);
		const block = session.turns[0].contentBlocks[0];
		expect(block.type).toBe('bash_command');
		if (block.type === 'bash_command') {
			expect(block.command).toBe('mkdir test');
			expect(block.stdout).toBe('');
			expect(block.stderr).toBe('');
		}
	});

	it('handles bash-input without subsequent bash-stdout (orphaned)', () => {
		const session = parse(jsonl(
			userBashInput('./orphan.sh'),
			userText('next question'),
			assistantText('response'),
		));

		expect(session.turns).toHaveLength(3);
		expect(session.turns[0].contentBlocks[0].type).toBe('bash_command');
		if (session.turns[0].contentBlocks[0].type === 'bash_command') {
			expect(session.turns[0].contentBlocks[0].command).toBe('./orphan.sh');
			expect(session.turns[0].contentBlocks[0].stdout).toBe('');
		}
		expect(session.turns[1].contentBlocks[0].type).toBe('text');
	});

	it('handles bash commands between assistant turns', () => {
		const session = parse(jsonl(
			assistantText('first response'),
			userBashInput('ls'),
			userBashOutput('file1.ts\nfile2.ts'),
			assistantText('second response'),
		));

		expect(session.turns).toHaveLength(3);
		expect(session.turns[0].role).toBe('assistant');
		expect(session.turns[1].role).toBe('user');
		expect(session.turns[1].contentBlocks[0].type).toBe('bash_command');
		expect(session.turns[2].role).toBe('assistant');
	});
});
