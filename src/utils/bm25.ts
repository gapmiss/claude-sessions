/**
 * BM25 relevance scoring engine for session search.
 *
 * Pure TypeScript implementation — no external dependencies.
 * Provides term-frequency / inverse-document-frequency ranking
 * with configurable parameters.
 */

// ── BM25 Parameters ────────────────────────────────────────

/** Term saturation: higher = slower diminishing returns for repeated terms. */
const K1 = 1.2;
/** Length normalization: 0 = ignore doc length, 1 = full normalization. */
const B = 0.75;

// ── Tokenizer & Stemmer ────────────────────────────────────

const STOP_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
	'of', 'with', 'by', 'is', 'it', 'as', 'be', 'was', 'are', 'were',
	'been', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
	'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
	'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us',
	'them', 'my', 'your', 'his', 'its', 'our', 'their', 'not', 'no',
	'from', 'if', 'so', 'than', 'then', 'when', 'what', 'which', 'who',
	'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
	'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just',
]);

/** Split text into normalized lowercase tokens, stripping punctuation. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Lightweight Porter-style suffix stemmer.
 * Handles the most common English suffixes — not perfect, but fast and dependency-free.
 */
export function stem(word: string): string {
	if (word.length < 4) return word;

	// Step 1: plural / -ed / -ing
	if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
	if (word.endsWith('sses')) return word.slice(0, -2);
	if (word.endsWith('ness')) return word.slice(0, -4);
	if (word.endsWith('ing') && word.length > 5) {
		const base = word.slice(0, -3);
		if (base.endsWith('e')) return base; // not double-e
		return base;
	}
	if (word.endsWith('ed') && word.length > 4) {
		const base = word.slice(0, -2);
		if (base.endsWith('e')) return base;
		return base;
	}
	if (word.endsWith('tion')) return word.slice(0, -4) + 't';
	if (word.endsWith('ment') && word.length > 6) return word.slice(0, -4);
	if (word.endsWith('able') && word.length > 6) return word.slice(0, -4);
	if (word.endsWith('ible') && word.length > 6) return word.slice(0, -4);
	if (word.endsWith('ally') && word.length > 5) return word.slice(0, -4);
	if (word.endsWith('ful')) return word.slice(0, -3);
	if (word.endsWith('ous') && word.length > 5) return word.slice(0, -3);
	if (word.endsWith('ive') && word.length > 5) return word.slice(0, -3);
	if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
	if (word.endsWith('er') && word.length > 4) return word.slice(0, -2);
	// -ses, -xes, -zes, -ches, -shes → remove -es (processes→process, boxes→box)
	if (word.endsWith('es') && word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
	if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);

	return word;
}

/** Tokenize and stem text into search terms. */
export function analyze(text: string): string[] {
	return tokenize(text).map(stem);
}

// ── BM25 Index ─────────────────────────────────────────────

export interface BM25Document<T = unknown> {
	/** Unique document ID. */
	id: string;
	/** Stemmed term frequencies. */
	termFreqs: Map<string, number>;
	/** Total number of stemmed terms. */
	length: number;
	/** Arbitrary payload carried through to results. */
	data: T;
}

export interface BM25Result<T = unknown> {
	id: string;
	score: number;
	data: T;
}

export class BM25Index<T = unknown> {
	private docs: Map<string, BM25Document<T>> = new Map();
	/** Number of documents containing each term. */
	private docFreqs: Map<string, number> = new Map();
	private totalDocLength = 0;

	get size(): number {
		return this.docs.size;
	}

	get avgDocLength(): number {
		return this.docs.size > 0 ? this.totalDocLength / this.docs.size : 0;
	}

	/** Add or replace a document. */
	add(id: string, text: string, data: T): void {
		// Remove old version if replacing
		if (this.docs.has(id)) {
			this.remove(id);
		}

		const terms = analyze(text);
		const termFreqs = new Map<string, number>();
		for (const term of terms) {
			termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
		}

		const doc: BM25Document<T> = { id, termFreqs, length: terms.length, data };
		this.docs.set(id, doc);
		this.totalDocLength += doc.length;

		// Update document frequencies
		for (const term of termFreqs.keys()) {
			this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
		}
	}

	/** Remove a document by ID. */
	remove(id: string): boolean {
		const doc = this.docs.get(id);
		if (!doc) return false;

		this.totalDocLength -= doc.length;
		for (const term of doc.termFreqs.keys()) {
			const df = this.docFreqs.get(term);
			if (df !== undefined) {
				if (df <= 1) this.docFreqs.delete(term);
				else this.docFreqs.set(term, df - 1);
			}
		}
		this.docs.delete(id);
		return true;
	}

	/** Clear all documents. */
	clear(): void {
		this.docs.clear();
		this.docFreqs.clear();
		this.totalDocLength = 0;
	}

	/**
	 * Query the index. Returns documents ranked by BM25 score (descending).
	 * @param queryText  Raw query string (will be tokenized + stemmed)
	 * @param limit      Max results to return (default 50)
	 */
	search(queryText: string, limit = 50): BM25Result<T>[] {
		const queryTerms = analyze(queryText);
		if (queryTerms.length === 0) return [];

		const N = this.docs.size;
		const avgDl = this.avgDocLength;
		const results: BM25Result<T>[] = [];

		for (const doc of this.docs.values()) {
			let score = 0;

			for (const term of queryTerms) {
				const tf = doc.termFreqs.get(term) ?? 0;
				if (tf === 0) continue;

				const df = this.docFreqs.get(term) ?? 0;
				// IDF with smoothing (BM25 standard formula)
				const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
				// TF saturation with length normalization
				const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / avgDl)));
				score += idf * tfNorm;
			}

			if (score > 0) {
				results.push({ id: doc.id, score, data: doc.data });
			}
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}
}
