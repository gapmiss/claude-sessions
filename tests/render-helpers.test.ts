import { describe, it, expect } from 'vitest';
import { normalizeMarkdown, stripFenceMarkers, buildInlineHookEventMap, summarizeStopHooks, shortHookCommand } from '../src/views/render-helpers';
import type { SystemEvent } from '../src/types';

describe('normalizeMarkdown', () => {
	it('inserts a blank line before a GFM table', () => {
		expect(normalizeMarkdown('intro\n| a | b |\n|---|---|\n| 1 | 2 |'))
			.toBe('intro\n\n| a | b |\n|---|---|\n| 1 | 2 |');
	});

	// A block opening with `---` was read as a YAML frontmatter delimiter by
	// MarkdownRenderer, swallowing everything up to the next `---`.
	it('rewrites a leading thematic break so it is not parsed as frontmatter', () => {
		expect(normalizeMarkdown('---\n\n**report**\n\nbody\n\n---'))
			.toBe('***\n\n**report**\n\nbody\n\n---');
	});

	it('rewrites a bare leading thematic break', () => {
		expect(normalizeMarkdown('---')).toBe('***');
	});

	it('leaves a setext heading underline alone', () => {
		expect(normalizeMarkdown('Heading\n---\nbody')).toBe('Heading\n---\nbody');
	});

	it('leaves a longer dash run alone', () => {
		expect(normalizeMarkdown('----\nbody')).toBe('----\nbody');
	});
});

describe('stripFenceMarkers', () => {
	it('removes a wrapping fence', () => {
		expect(stripFenceMarkers('```\n  ███\n  ░░░\n```')).toBe('  ███\n  ░░░');
	});

	it('removes a fence with a language tag', () => {
		expect(stripFenceMarkers('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
	});

	it('removes a tilde fence', () => {
		expect(stripFenceMarkers('~~~\nart\n~~~')).toBe('art');
	});

	// The most common real shape: fenced art followed by explanatory prose.
	it('removes a mid-string closing fence, keeping trailing prose', () => {
		expect(stripFenceMarkers('```\n  ███\n```\nMETAPHOR:\n• idle: hops'))
			.toBe('  ███\nMETAPHOR:\n• idle: hops');
	});

	it('removes an unclosed opening fence', () => {
		expect(stripFenceMarkers('```\nart')).toBe('art');
	});

	it('leaves unfenced ASCII art untouched', () => {
		const art = '┌────────┐\n│ Agent  │\n└────────┘';
		expect(stripFenceMarkers(art)).toBe(art);
	});

	it('preserves interior blank lines and indentation', () => {
		expect(stripFenceMarkers('```\n  a\n\n    b\n```')).toBe('  a\n\n    b');
	});

	it('leaves inline backticks alone', () => {
		expect(stripFenceMarkers('use `foo` here')).toBe('use `foo` here');
	});

	// Real corpus case: a tilde run is a dirt mound, not a fence — the trailing
	// annotation is what keeps it from looking like one.
	it('keeps a tilde run that carries trailing content', () => {
		const art = '   /\\\\\n ~~~~~~~~~~~ <- dirt mound';
		expect(stripFenceMarkers(art)).toBe(art);
	});
});

describe('buildInlineHookEventMap', () => {
	const at = (type: string, toolUseId?: string) =>
		({ type, uuid: type, timestamp: '2026-01-01T00:00:00.000Z', toolUseId }) as unknown as SystemEvent;

	it('groups every tool-scoped event type by its tool call', () => {
		const map = buildInlineHookEventMap([
			at('hook_success', 't1'),
			at('hook_permission_decision', 't1'),
			at('read_truncation_notice', 't2'),
			at('hook_blocking_error', 't2'),
			at('hook_non_blocking_error', 't2'),
			at('async_hook_response', 't3'),
		]);

		expect(map.get('t1')).toHaveLength(2);
		expect(map.get('t2')?.map(e => e.type)).toEqual([
			'read_truncation_notice', 'hook_blocking_error', 'hook_non_blocking_error',
		]);
		expect(map.get('t3')).toHaveLength(1);
	});

	it('skips events with no toolUseId and types that are not tool-scoped', () => {
		const map = buildInlineHookEventMap([
			at('hook_success'),
			at('output_style', 't1'),
			at('skill_listing', 't1'),
		]);

		expect(map.size).toBe(0);
	});
});

describe('summarizeStopHooks', () => {
	const summary = (hooks: { command: string; durationMs?: number }[], errors: string[] = [], preventedContinuation = false): SystemEvent => ({
		type: 'stop_hook_summary', uuid: crypto.randomUUID(), timestamp: '', hooks, errors, preventedContinuation,
	});

	it('groups runs by command and averages only reported durations', () => {
		const result = summarizeStopHooks([
			summary([{ command: 'bridge.sh', durationMs: 40 }, { command: 'Stop notification' }]),
			summary([{ command: 'bridge.sh', durationMs: 60 }, { command: 'Stop notification' }]),
		]);

		expect(result.groups).toEqual([
			{ command: 'bridge.sh', runs: 2, avgMs: 50 },
			{ command: 'Stop notification', runs: 2, avgMs: undefined },
		]);
		expect(result.totalRuns).toBe(4);
	});

	it('counts repeated errors and blocked stops', () => {
		const result = summarizeStopHooks([
			summary([{ command: 'a' }], ['missing script']),
			summary([{ command: 'a' }], ['missing script'], true),
		]);

		expect(result.errors).toEqual([{ message: 'missing script', count: 2 }]);
		expect(result.preventedCount).toBe(1);
	});

	it('ignores other event types', () => {
		const result = summarizeStopHooks([
			{ type: 'output_style', uuid: 'x', timestamp: '', style: 'Terse' } as SystemEvent,
		]);
		expect(result).toEqual({ groups: [], errors: [], preventedCount: 0, totalRuns: 0 });
	});
});

describe('shortHookCommand', () => {
	it('drops the directory from a quoted path and keeps arguments', () => {
		expect(shortHookCommand("'/Users/gm/.doorman/hook.sh' stop")).toBe('hook.sh stop');
		expect(shortHookCommand('"$HOME/.local/bin/lockpaw" ping')).toBe('lockpaw ping');
	});

	it('handles unquoted commands and plain labels', () => {
		expect(shortHookCommand('/Users/gm/.ccnotify/bridge.sh')).toBe('bridge.sh');
		expect(shortHookCommand('python3 ~/.claude/hooks/state.py')).toBe('python3 ~/.claude/hooks/state.py');
		expect(shortHookCommand('Stop notification')).toBe('Stop notification');
	});
});
