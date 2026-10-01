import { describe, it, expect } from 'vitest';
import { signatureTag, isNarrationSignature } from '../src/parsers/thinking-signature';
import { parseContentBlock } from '../src/parsers/claude-content';

// Minimal protobuf encoding for building signatures in the shape Claude Code
// writes: field 2 -> field 1 -> field 8 (tag string).
function varint(n: number): number[] {
	const out: number[] = [];
	while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
	out.push(n);
	return out;
}
function bytesField(field: number, payload: number[]): number[] {
	return [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
}
function ascii(s: string): number[] {
	return Array.from(s, c => c.charCodeAt(0));
}
function signature(tag: string, filler = 0): string {
	// A varint field and some opaque bytes around the tag, like the real thing
	const inner = [...varint(1 * 8 + 0), 18, ...bytesField(8, ascii(tag)), ...bytesField(2, new Array<number>(filler).fill(7))];
	const outer = [...varint(1 * 8 + 0), 4, ...bytesField(2, bytesField(1, inner))];
	return btoa(String.fromCharCode(...outer));
}

describe('signatureTag', () => {
	it('reads the tag from a nested signature', () => {
		expect(signatureTag(signature('thinking'))).toBe('thinking');
		expect(signatureTag(signature('narration'))).toBe('narration');
	});

	it('handles multi-byte lengths', () => {
		expect(signatureTag(signature('narration', 300))).toBe('narration');
	});

	it('returns undefined for garbage', () => {
		expect(signatureTag('not base64!!')).toBeUndefined();
		expect(signatureTag(btoa('\x12\xff'))).toBeUndefined();
		expect(signatureTag('')).toBeUndefined();
	});
});

describe('isNarrationSignature', () => {
	it('is true only for the narration tag', () => {
		expect(isNarrationSignature(signature('narration'))).toBe(true);
		expect(isNarrationSignature(signature('thinking'))).toBe(false);
		expect(isNarrationSignature(undefined)).toBe(false);
	});
});

describe('parseContentBlock with narration', () => {
	const names = new Map<string, string>();

	it('turns narration-tagged thinking into text', () => {
		const result = parseContentBlock(
			{ type: 'thinking', thinking: 'The merge worked.\n\n', signature: signature('narration') },
			names,
		);
		expect(result).toEqual({ type: 'text', text: 'The merge worked.', timestamp: undefined });
	});

	it('keeps ordinary thinking as thinking', () => {
		const result = parseContentBlock(
			{ type: 'thinking', thinking: 'Hmm.', signature: signature('thinking') },
			names,
		);
		expect(result?.type).toBe('thinking');
	});
});
