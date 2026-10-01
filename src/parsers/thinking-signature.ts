import { SIGNATURE_TAG_FIELD, SIGNATURE_TAG_NARRATION, SIGNATURE_TAG_PATH } from '../constants';

/** Read a protobuf varint at `pos`. Returns undefined on truncated input. */
function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } | undefined {
	let value = 0;
	let mult = 1;
	for (let i = pos; i < buf.length && i < pos + 10; i++) {
		const b = buf[i];
		value += (b & 0x7f) * mult;
		if ((b & 0x80) === 0) return { value, next: i + 1 };
		mult *= 128;
	}
	return undefined;
}

/**
 * Return the last length-delimited value for `field` in a protobuf message,
 * or undefined if the field is absent or the message is malformed.
 */
function findBytesField(buf: Uint8Array, field: number): Uint8Array | undefined {
	let pos = 0;
	let found: Uint8Array | undefined;
	while (pos < buf.length) {
		const key = readVarint(buf, pos);
		if (!key) return undefined;
		pos = key.next;
		const wireType = key.value % 8;
		const num = Math.floor(key.value / 8);
		switch (wireType) {
			case 0: {
				const v = readVarint(buf, pos);
				if (!v) return undefined;
				pos = v.next;
				break;
			}
			case 1:
				pos += 8;
				break;
			case 2: {
				const len = readVarint(buf, pos);
				if (!len || len.value > buf.length - len.next) return undefined;
				pos = len.next + len.value;
				if (num === field) found = buf.subarray(len.next, pos);
				break;
			}
			case 5:
				pos += 4;
				break;
			default:
				return undefined;
		}
		if (pos > buf.length) return undefined;
	}
	return found;
}

/** Extract the tag string from a thinking block signature, if it has one. */
export function signatureTag(signature: string): string | undefined {
	let bin: string;
	try {
		bin = atob(signature);
	} catch {
		return undefined;
	}
	let buf: Uint8Array | undefined = Uint8Array.from(bin, c => c.charCodeAt(0));
	for (const field of SIGNATURE_TAG_PATH) {
		buf = findBytesField(buf, field);
		if (!buf) return undefined;
	}
	const tag = findBytesField(buf, SIGNATURE_TAG_FIELD);
	return tag ? new TextDecoder().decode(tag) : undefined;
}

/** True when the signature marks a thinking block as user-facing narration. */
export function isNarrationSignature(signature: string | undefined): boolean {
	return !!signature && signatureTag(signature) === SIGNATURE_TAG_NARRATION;
}
