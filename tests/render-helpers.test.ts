import { describe, it, expect } from 'vitest';
import { normalizeMarkdown, stripFenceMarkers } from '../src/views/render-helpers';

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
