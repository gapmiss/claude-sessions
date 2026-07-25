import { describe, it, expect } from 'vitest';
import { normalizeMarkdown } from '../src/views/render-helpers';

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
