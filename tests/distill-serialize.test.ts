import { describe, it, expect } from 'vitest';
import { serializeFrontmatter, wrapFrontmatter } from '../src/distill/serialize-frontmatter';
import { buildNoteName, buildLayer0Note, mergeNoteContent } from '../src/distill/build-note';
import { DistilledFrontmatter, DISTILL_SCHEMA_VERSION } from '../src/distill/types';

// ── Test Helpers ───────────────────────────────────────────

function makeMinimalFrontmatter(overrides: Partial<DistilledFrontmatter> = {}): DistilledFrontmatter {
	return {
		tags: ['claude-session'],
		session_id: 'abc12345-6789-0123-4567-890abcdef012',
		schema_version: DISTILL_SCHEMA_VERSION,
		project: 'test-project',
		cwd: '/Users/test/projects/my-app',
		...overrides,
	};
}

// ── serializeFrontmatter ───────────────────────────────────

describe('serializeFrontmatter', () => {
	it('serializes minimal frontmatter', () => {
		const fm = makeMinimalFrontmatter();
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('tags:');
		expect(yaml).toContain('  - claude-session');
		expect(yaml).toContain('session_id: abc12345-6789-0123-4567-890abcdef012');
		expect(yaml).toContain('schema_version: 1');
		expect(yaml).toContain('project: test-project');
		expect(yaml).toContain('cwd: /Users/test/projects/my-app');
	});

	it('serializes optional metadata', () => {
		const fm = makeMinimalFrontmatter({
			branch: 'main',
			model: 'claude-opus-4-6',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('branch: main');
		expect(yaml).toContain('model: claude-opus-4-6');
	});

	it('serializes timing fields', () => {
		const fm = makeMinimalFrontmatter({
			start_time: '2026-04-08T14:30:00Z',
			duration_min: 45.5,
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('start_time: 2026-04-08T14:30:00Z');
		expect(yaml).toContain('duration_min: 45.5');
	});

	it('serializes cost and token fields', () => {
		const fm = makeMinimalFrontmatter({
			cost_usd: 2.34,
			input_tokens: 150000,
			output_tokens: 28000,
			cache_read_tokens: 89000,
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('cost_usd: 2.34');
		expect(yaml).toContain('input_tokens: 150000');
		expect(yaml).toContain('output_tokens: 28000');
		expect(yaml).toContain('cache_read_tokens: 89000');
	});

	it('serializes tools_used in flow style', () => {
		const fm = makeMinimalFrontmatter({
			tools_used: ['Bash', 'Edit', 'Read'],
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('tools_used: [Bash, Edit, Read]');
	});

	it('serializes files_touched in block style', () => {
		const fm = makeMinimalFrontmatter({
			files_touched: ['[[src/main.ts]]', '[[src/utils.ts]]'],
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('files_touched:');
		expect(yaml).toContain('  - "[[src/main.ts]]"');
		expect(yaml).toContain('  - "[[src/utils.ts]]"');
	});

	it('serializes error_count', () => {
		const fm = makeMinimalFrontmatter({
			error_count: 7,
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('error_count: 7');
	});

	it('serializes session_type', () => {
		const fm = makeMinimalFrontmatter({
			session_type: ['bug-fix', 'refactor'],
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('session_type:');
		expect(yaml).toContain('  - bug-fix');
		expect(yaml).toContain('  - refactor');
	});

	it('serializes source_path', () => {
		const fm = makeMinimalFrontmatter({
			source_path: '/Users/test/.claude/sessions/session.jsonl',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('source_path: /Users/test/.claude/sessions/session.jsonl');
	});

	it('serializes obsidian_uri', () => {
		const fm = makeMinimalFrontmatter({
			source_path: '/Users/test/.claude/sessions/session.jsonl',
			obsidian_uri: 'obsidian://claude-sessions?session=%2FUsers%2Ftest%2F.claude%2Fsessions%2Fsession.jsonl',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('obsidian_uri: "obsidian://claude-sessions?session=%2FUsers%2Ftest%2F.claude%2Fsessions%2Fsession.jsonl"');
	});
});

// ── YAML Quoting ───────────────────────────────────────────

describe('serializeFrontmatter - quoting', () => {
	it('quotes strings with colons', () => {
		const fm = makeMinimalFrontmatter({
			project: 'my-project: v2',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('project: "my-project: v2"');
	});

	it('quotes strings with newlines', () => {
		const fm = makeMinimalFrontmatter({
			source_path: '/path/with\nnewline',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('"');
		expect(yaml).toContain('\\n');
	});

	it('quotes strings starting with numbers', () => {
		const fm = makeMinimalFrontmatter({
			project: '2026-project',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('project: "2026-project"');
	});

	it('quotes boolean-like strings', () => {
		const fm = makeMinimalFrontmatter({
			branch: 'true',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('branch: "true"');
	});

	it('escapes quotes in strings', () => {
		const fm = makeMinimalFrontmatter({
			source_path: '/path/with "quotes"',
		});
		const yaml = serializeFrontmatter(fm);

		expect(yaml).toContain('\\"quotes\\"');
	});
});

// ── wrapFrontmatter ────────────────────────────────────────

describe('wrapFrontmatter', () => {
	it('wraps YAML with delimiters', () => {
		const yaml = 'key: value';
		const wrapped = wrapFrontmatter(yaml);

		expect(wrapped).toBe('---\nkey: value\n---');
	});
});

// ── buildNoteName ──────────────────────────────────────────

describe('buildNoteName', () => {
	it('generates correct name format', () => {
		const fm = makeMinimalFrontmatter({
			project: 'my-project',
			start_time: '2026-04-08T14:30:00Z',
			session_id: 'abc12345-6789-0123',
		});
		const name = buildNoteName(fm);

		expect(name).toBe('my-project--2026-04-08--abc12345.md');
	});

	it('sanitizes project name', () => {
		const fm = makeMinimalFrontmatter({
			project: 'My Project!!! v2.0',
			start_time: '2026-04-08T14:30:00Z',
		});
		const name = buildNoteName(fm);

		expect(name).toMatch(/^my-project-v2-0--/);
	});

	it('handles missing start_time', () => {
		const fm = makeMinimalFrontmatter({
			start_time: undefined,
		});
		const name = buildNoteName(fm);

		expect(name).toContain('--undated--');
	});

	it('uses first 8 chars of session_id', () => {
		const fm = makeMinimalFrontmatter({
			session_id: 'abcdefghijklmnop',
			start_time: '2026-04-08T14:30:00Z',
		});
		const name = buildNoteName(fm);

		expect(name.endsWith('--abcdefgh.md')).toBe(true);
	});
});

// ── buildLayer0Note ────────────────────────────────────────

describe('buildLayer0Note', () => {
	it('includes frontmatter and stats table', () => {
		const fm = makeMinimalFrontmatter({
			duration_min: 45,
			cost_usd: 2.34,
			user_turns: 12,
			assistant_turns: 12,
			tools_used: ['Read', 'Edit', 'Bash'],
			input_tokens: 150000,
			output_tokens: 28000,
		});
		const note = buildLayer0Note(fm);

		// Has frontmatter delimiters
		expect(note).toMatch(/^---\n/);
		expect(note).toContain('\n---\n');

		// Has stats section
		expect(note).toContain('## Stats');
		expect(note).toContain('| Metric | Value |');
		expect(note).toContain('| Duration | 45 min |');
		expect(note).toContain('| Cost | $2.34 |');
		expect(note).toContain('| Turns | 12 user / 12 assistant |');
		expect(note).toContain('| Tools | Read, Edit, Bash |');
		expect(note).toContain('| Tokens | 178k total |');
	});

	it('formats duration correctly', () => {
		// Seconds
		let fm = makeMinimalFrontmatter({ duration_min: 0.5 });
		let note = buildLayer0Note(fm);
		expect(note).toContain('| Duration | 30 sec |');

		// Minutes
		fm = makeMinimalFrontmatter({ duration_min: 15 });
		note = buildLayer0Note(fm);
		expect(note).toContain('| Duration | 15 min |');

		// Hours
		fm = makeMinimalFrontmatter({ duration_min: 90 });
		note = buildLayer0Note(fm);
		expect(note).toContain('| Duration | 1h 30m |');

		// Full hours
		fm = makeMinimalFrontmatter({ duration_min: 120 });
		note = buildLayer0Note(fm);
		expect(note).toContain('| Duration | 2h |');
	});

	it('omits missing stats', () => {
		const fm = makeMinimalFrontmatter();  // minimal, no stats
		const note = buildLayer0Note(fm);

		expect(note).not.toContain('Duration');
		expect(note).not.toContain('Cost');
		expect(note).not.toContain('Turns');
		expect(note).not.toContain('Tools');
		expect(note).not.toContain('Tokens');
	});
});

// ── mergeNoteContent ───────────────────────────────────────

describe('mergeNoteContent', () => {
	const layer0Note = `---
tags:
  - claude-session
session_id: abc12345
schema_version: 1

project: my-project
cwd: /Users/test/my-project

start_time: 2026-04-09T14:30:00Z
duration_min: 18.7

cost_usd: 11.77
input_tokens: 1272
output_tokens: 34984

user_turns: 3
assistant_turns: 2
tools_used: [Bash, Edit, Read]
files_touched:
  - "[[src/main.ts]]"
  - "[[src/utils.ts]]"

source_path: /path/to/session.jsonl
---

## Stats

| Metric | Value |
|---|---|
| Duration | 19 min |
| Cost | $11.77 |
`;

	const llmNote = `---
tags:
  - claude-session
  - claude-session/feature
session_id: placeholder
schema_version: 1

project: my-project
cwd: /Users/test/my-project

duration_min: 8
cost_usd: 0.50
input_tokens: 50000
output_tokens: 15000

tools_used: [Bash, Edit]
files_touched:
  - "[[src/main.ts]]"
  - "[[src/api.ts]]"

session_type:
  - feature

source_path: /wrong/path.jsonl
---

## Summary

Did some great work on the feature.

## Decisions

- **Decision 1**: Chose X because Y

## Learnings

- Learned something useful
`;

	it('preserves LLM narrative sections', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		expect(merged).toContain('## Summary');
		expect(merged).toContain('Did some great work on the feature.');
		expect(merged).toContain('## Decisions');
		expect(merged).toContain('## Learnings');
	});

	it('uses Layer 0 numeric values', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		// Layer 0 values should win
		expect(merged).toContain('cost_usd: 11.77');
		expect(merged).toContain('duration_min: 18.7');
		expect(merged).toContain('input_tokens: 1272');
		expect(merged).toContain('output_tokens: 34984');

		// LLM approximations should be gone
		expect(merged).not.toContain('cost_usd: 0.50');
		expect(merged).not.toContain('input_tokens: 50000');
	});

	it('uses Layer 0 session_id', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		expect(merged).toContain('session_id: abc12345');
		expect(merged).not.toContain('session_id: placeholder');
	});

	it('preserves LLM session_type classification', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		expect(merged).toContain('session_type:');
		expect(merged).toContain('- feature');
	});

	it('merges tags from both sources', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		expect(merged).toContain('- claude-session');
		expect(merged).toContain('- claude-session/feature');
	});

	it('merges files_touched from both sources', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		// Both Layer 0 and LLM files should be present
		expect(merged).toContain('[[src/main.ts]]');
		expect(merged).toContain('[[src/utils.ts]]');  // Layer 0 only
		expect(merged).toContain('[[src/api.ts]]');    // LLM only
	});

	it('uses Layer 0 source_path', () => {
		const merged = mergeNoteContent(layer0Note, llmNote);

		expect(merged).toContain('source_path: /path/to/session.jsonl');
		expect(merged).not.toContain('/wrong/path.jsonl');
	});

	it('returns Layer 0 content when LLM has no narrative', () => {
		const llmNoNarrative = `---
session_id: test
schema_version: 1
project: test
cwd: /test
---

## Stats

| Metric | Value |
`;
		const merged = mergeNoteContent(layer0Note, llmNoNarrative);

		// Should return Layer 0 since LLM has no Summary section
		expect(merged).toBe(layer0Note);
	});

	it('returns LLM content when Layer 0 has no frontmatter', () => {
		const noFrontmatter = 'Just some text without frontmatter';
		const merged = mergeNoteContent(noFrontmatter, llmNote);

		expect(merged).toBe(llmNote);
	});
});
