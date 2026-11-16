import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sessionDisplayName } from '../src/utils/session-title';
import { extractQuickMetadataAsync } from '../src/utils/streaming-reader';

describe('sessionDisplayName', () => {
	it('prefers the /rename title', () => {
		expect(sessionDisplayName({ customTitle: 'mine', aiTitle: 'generated', project: 'proj' })).toBe('mine');
	});

	it('falls back to the generated title', () => {
		expect(sessionDisplayName({ aiTitle: 'generated', project: 'proj' })).toBe('generated');
	});

	it('falls back to the project name', () => {
		expect(sessionDisplayName({ project: 'proj' })).toBe('proj');
	});

	it('ignores empty titles', () => {
		expect(sessionDisplayName({ customTitle: '', aiTitle: '', project: 'proj' })).toBe('proj');
	});
});

describe('extractQuickMetadataAsync - titles', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-title-'));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	function writeSession(name: string, records: unknown[]): string {
		const file = path.join(dir, name);
		fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
		return file;
	}

	const user = { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } };

	it('reads the last ai-title, including ones past the basic metadata window', async () => {
		const filler = Array.from({ length: 150 }, () => user);
		const file = writeSession('ai.jsonl', [
			user,
			{ type: 'ai-title', aiTitle: 'First guess', sessionId: 's1' },
			...filler,
			{ type: 'ai-title', aiTitle: 'Final title', sessionId: 's1' },
		]);
		const meta = await extractQuickMetadataAsync(file);
		expect(meta.aiTitle).toBe('Final title');
		expect(meta.customTitle).toBeUndefined();
		expect(meta.hasContent).toBe(true);
	});

	it('reads both titles when both exist', async () => {
		const file = writeSession('both.jsonl', [
			user,
			{ type: 'ai-title', aiTitle: 'Generated', sessionId: 's1' },
			{ type: 'custom-title', customTitle: 'mine', sessionId: 's1' },
		]);
		const meta = await extractQuickMetadataAsync(file);
		expect(meta.aiTitle).toBe('Generated');
		expect(meta.customTitle).toBe('mine');
	});
});
