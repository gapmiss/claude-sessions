import { describe, it, expect } from 'vitest';
import { extractFrontmatter } from '../src/distill/extract-frontmatter';
import { Session, SessionMetadata, SessionStats, Turn, ToolUseBlock, ToolResultBlock, TextBlock } from '../src/types';
import { DISTILL_SCHEMA_VERSION } from '../src/distill/types';

// ── Test Helpers ───────────────────────────────────────────

function makeSession(overrides: Partial<{
	metadata: Partial<SessionMetadata>;
	stats: Partial<SessionStats>;
	turns: Turn[];
	rawPath: string;
}> = {}): Session {
	return {
		metadata: {
			id: 'test-session-123',
			format: 'claude',
			project: 'test-project',
			cwd: '/Users/test/projects/my-app',
			totalTurns: 2,
			...overrides.metadata,
		},
		stats: {
			userTurns: 1,
			assistantTurns: 1,
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200,
			cacheCreationTokens: 0,
			totalTokens: 1700,
			contextWindowTokens: 1200,
			costUSD: 0.05,
			toolUseCounts: {},
			durationMs: 60000,
			...overrides.stats,
		},
		turns: overrides.turns ?? [],
		systemEvents: [],
		rawPath: overrides.rawPath ?? '/Users/test/.claude/sessions/test.jsonl',
	};
}

function makeToolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
	return {
		type: 'tool_use',
		id: `tool-${Math.random().toString(36).slice(2)}`,
		name,
		input,
	};
}

function makeToolResult(content: string, isError = false): ToolResultBlock {
	return {
		type: 'tool_result',
		toolUseId: 'tool-123',
		content,
		isError,
	};
}

function makeTurn(role: 'user' | 'assistant', blocks: (ToolUseBlock | ToolResultBlock | TextBlock)[]): Turn {
	return {
		index: 0,
		role,
		contentBlocks: blocks,
	};
}

// ── Basic Extraction ───────────────────────────────────────

describe('extractFrontmatter', () => {
	it('extracts basic metadata', () => {
		const session = makeSession();
		const fm = extractFrontmatter(session);

		expect(fm.session_id).toBe('test-session-123');
		expect(fm.project).toBe('test-project');
		expect(fm.cwd).toBe('/Users/test/projects/my-app');
		expect(fm.schema_version).toBe(DISTILL_SCHEMA_VERSION);
		expect(fm.tags).toContain('claude-session');
	});

	it('extracts optional metadata fields', () => {
		const session = makeSession({
			metadata: {
				branch: 'main',
				model: 'claude-opus-4-6',
				startTime: '2026-04-08T14:30:00Z',
			},
		});
		const fm = extractFrontmatter(session);

		expect(fm.branch).toBe('main');
		expect(fm.model).toBe('claude-opus-4-6');
		expect(fm.start_time).toBe('2026-04-08T14:30:00Z');
	});

	it('extracts stats', () => {
		const session = makeSession({
			stats: {
				userTurns: 5,
				assistantTurns: 5,
				inputTokens: 10000,
				outputTokens: 5000,
				cacheReadTokens: 3000,
				costUSD: 1.23,
				durationMs: 300000,  // 5 minutes
			},
		});
		const fm = extractFrontmatter(session);

		expect(fm.user_turns).toBe(5);
		expect(fm.assistant_turns).toBe(5);
		expect(fm.input_tokens).toBe(10000);
		expect(fm.output_tokens).toBe(5000);
		expect(fm.cache_read_tokens).toBe(3000);
		expect(fm.cost_usd).toBe(1.23);
		expect(fm.duration_min).toBe(5);
	});

	it('extracts tools used', () => {
		const session = makeSession({
			stats: {
				toolUseCounts: {
					Read: 10,
					Edit: 5,
					Bash: 3,
				},
			},
		});
		const fm = extractFrontmatter(session);

		expect(fm.tools_used).toEqual(['Bash', 'Edit', 'Read']);  // sorted
	});

	it('extracts source_path', () => {
		const session = makeSession({
			rawPath: '/custom/path/to/session.jsonl',
		});
		const fm = extractFrontmatter(session);

		expect(fm.source_path).toBe('/custom/path/to/session.jsonl');
	});

	it('extracts obsidian_uri', () => {
		const session = makeSession({
			rawPath: '/Users/test/.claude/sessions/test.jsonl',
		});
		const fm = extractFrontmatter(session);

		expect(fm.obsidian_uri).toBe(
			'obsidian://claude-sessions?session=%2FUsers%2Ftest%2F.claude%2Fsessions%2Ftest.jsonl'
		);
	});
});

// ── File Path Extraction ───────────────────────────────────

describe('extractFrontmatter - files_touched', () => {
	it('extracts file paths from Read tool', () => {
		const session = makeSession({
			turns: [
				makeTurn('assistant', [
					makeToolUse('Read', { file_path: '/Users/test/projects/my-app/src/main.ts' }),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.files_touched).toEqual(['[[src/main.ts]]']);
	});

	it('extracts file paths from Edit tool', () => {
		const session = makeSession({
			turns: [
				makeTurn('assistant', [
					makeToolUse('Edit', {
						file_path: '/Users/test/projects/my-app/src/utils.ts',
						old_string: 'foo',
						new_string: 'bar',
					}),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.files_touched).toEqual(['[[src/utils.ts]]']);
	});

	it('extracts file paths from Write tool', () => {
		const session = makeSession({
			turns: [
				makeTurn('assistant', [
					makeToolUse('Write', {
						file_path: '/Users/test/projects/my-app/new-file.ts',
						content: 'hello',
					}),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.files_touched).toEqual(['[[new-file.ts]]']);
	});

	it('extracts paths from Glob tool', () => {
		const session = makeSession({
			turns: [
				makeTurn('assistant', [
					makeToolUse('Glob', { path: '/Users/test/projects/my-app/src', pattern: '*.ts' }),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.files_touched).toEqual(['[[src]]']);
	});

	it('deduplicates file paths', () => {
		const session = makeSession({
			turns: [
				makeTurn('assistant', [
					makeToolUse('Read', { file_path: '/Users/test/projects/my-app/src/main.ts' }),
					makeToolUse('Edit', { file_path: '/Users/test/projects/my-app/src/main.ts', old_string: 'a', new_string: 'b' }),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.files_touched).toEqual(['[[src/main.ts]]']);
	});

	it('falls back to basename for external files', () => {
		const session = makeSession({
			metadata: { cwd: '/Users/test/projects/my-app' },
			turns: [
				makeTurn('assistant', [
					makeToolUse('Read', { file_path: '/etc/hosts' }),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.files_touched).toEqual(['[[hosts]]']);
	});
});

// ── Error Count ────────────────────────────────────────────

describe('extractFrontmatter - error_count', () => {
	it('counts errors from tool results', () => {
		const session = makeSession({
			turns: [
				makeTurn('user', [
					makeToolResult('TypeError: Cannot read property "foo" of undefined', true),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.error_count).toBe(1);
	});

	it('counts multiple errors', () => {
		const session = makeSession({
			turns: [
				makeTurn('user', [
					makeToolResult('Error: ENOENT', true),
				]),
				makeTurn('user', [
					makeToolResult('Error: ENOENT', true),
				]),
				makeTurn('user', [
					makeToolResult('TypeError', true),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.error_count).toBe(3);
	});

	it('ignores non-error tool results', () => {
		const session = makeSession({
			turns: [
				makeTurn('user', [
					makeToolResult('Success!', false),
				]),
			],
		});
		const fm = extractFrontmatter(session);

		expect(fm.error_count).toBeUndefined();
	});
});

// ── Edge Cases ─────────────────────────────────────────────

describe('extractFrontmatter - edge cases', () => {
	it('handles empty session', () => {
		const session = makeSession({
			turns: [],
			stats: {
				toolUseCounts: {},
				durationMs: 0,
				costUSD: 0,
				inputTokens: 0,
				outputTokens: 0,
			},
		});
		const fm = extractFrontmatter(session);

		expect(fm.session_id).toBe('test-session-123');
		expect(fm.tools_used).toBeUndefined();
		expect(fm.files_touched).toBeUndefined();
		expect(fm.error_count).toBeUndefined();
	});

	it('handles missing optional fields', () => {
		const session = makeSession({
			metadata: {
				branch: undefined,
				model: undefined,
				startTime: undefined,
			},
		});
		const fm = extractFrontmatter(session);

		expect(fm.branch).toBeUndefined();
		expect(fm.model).toBeUndefined();
		expect(fm.start_time).toBeUndefined();
	});
});
