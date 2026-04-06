import { describe, it, expect } from 'vitest';
import { tokenize, stem, analyze, BM25Index } from '../src/utils/bm25';

// ── Tokenizer ──────────────────────────────────────────────

describe('tokenize', () => {
	it('lowercases and splits on whitespace', () => {
		expect(tokenize('Hello World')).toEqual(['hello', 'world']);
	});

	it('strips punctuation', () => {
		expect(tokenize('file.ts: error!')).toEqual(['file', 'ts', 'error']);
	});

	it('removes stop words', () => {
		expect(tokenize('the quick brown fox')).toEqual(['quick', 'brown', 'fox']);
	});

	it('removes single-char tokens', () => {
		expect(tokenize('a b cd ef')).toEqual(['cd', 'ef']);
	});

	it('handles empty string', () => {
		expect(tokenize('')).toEqual([]);
	});
});

// ── Stemmer ────────────────────────────────────────────────

describe('stem', () => {
	it('stems plurals', () => {
		expect(stem('files')).toBe('file');
		expect(stem('queries')).toBe('query');
		expect(stem('processes')).toBe('process');
	});

	it('stems -ing', () => {
		expect(stem('running')).toBe('runn');
		expect(stem('searching')).toBe('search');
	});

	it('stems -ed', () => {
		expect(stem('searched')).toBe('search');
		expect(stem('imported')).toBe('import');
	});

	it('stems -tion', () => {
		expect(stem('creation')).toBe('creat');
	});

	it('preserves short words', () => {
		expect(stem('go')).toBe('go');
		expect(stem('run')).toBe('run');
	});
});

// ── Analyze ────────────────────────────────────────────────

describe('analyze', () => {
	it('tokenizes and stems', () => {
		const result = analyze('searching for files');
		expect(result).toContain('search');
		expect(result).toContain('file');
	});
});

// ── BM25 Index ─────────────────────────────────────────────

describe('BM25Index', () => {
	it('returns empty results for empty index', () => {
		const idx = new BM25Index();
		expect(idx.search('hello')).toEqual([]);
	});

	it('finds exact term match', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'authentication login flow', 'doc1');
		idx.add('2', 'database migration script', 'doc2');

		const results = idx.search('authentication');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe('1');
		expect(results[0].score).toBeGreaterThan(0);
	});

	it('ranks by term frequency', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'error error error handling', 'many errors');
		idx.add('2', 'error handling gracefully', 'one error');

		const results = idx.search('error');
		expect(results[0].id).toBe('1');
		expect(results[0].score).toBeGreaterThan(results[1].score);
	});

	it('ranks by IDF (rare terms score higher)', () => {
		const idx = new BM25Index<string>();
		// "code" appears in both, "authentication" only in doc1
		idx.add('1', 'authentication code review', 'auth doc');
		idx.add('2', 'code review best practices', 'generic doc');

		const results = idx.search('authentication code');
		expect(results[0].id).toBe('1');
	});

	it('handles multi-word queries', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'react component state management', 'react');
		idx.add('2', 'database migration rollback', 'db');
		idx.add('3', 'react hooks state updates', 'hooks');

		const results = idx.search('react state');
		expect(results.length).toBe(2);
		// Both react docs should appear, db doc should not
		const ids = results.map(r => r.id);
		expect(ids).toContain('1');
		expect(ids).toContain('3');
		expect(ids).not.toContain('2');
	});

	it('respects limit parameter', () => {
		const idx = new BM25Index<string>();
		for (let i = 0; i < 100; i++) {
			idx.add(String(i), `document about testing number ${i}`, `doc${i}`);
		}
		const results = idx.search('testing', 5);
		expect(results.length).toBe(5);
	});

	it('removes documents', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'hello world', 'doc1');
		idx.add('2', 'hello there', 'doc2');

		expect(idx.size).toBe(2);
		idx.remove('1');
		expect(idx.size).toBe(1);

		const results = idx.search('hello');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe('2');
	});

	it('replaces documents on re-add', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'original content', 'v1');
		idx.add('1', 'replacement content', 'v2');

		expect(idx.size).toBe(1);
		const results = idx.search('replacement');
		expect(results.length).toBe(1);
		expect(results[0].data).toBe('v2');
	});

	it('clears all documents', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'hello', 'a');
		idx.add('2', 'world', 'b');
		idx.clear();
		expect(idx.size).toBe(0);
		expect(idx.search('hello')).toEqual([]);
	});

	it('handles stemmed query matching', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'searching through files', 'search doc');
		idx.add('2', 'database connections', 'db doc');

		// "searches" should stem to match "searching"
		const results = idx.search('searches');
		expect(results.length).toBe(1);
		expect(results[0].id).toBe('1');
	});

	it('returns empty for stop-word-only queries', () => {
		const idx = new BM25Index<string>();
		idx.add('1', 'some content here', 'doc');
		expect(idx.search('the is a')).toEqual([]);
	});
});
