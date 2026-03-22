import { BaseParser } from './base-parser';
import { Session } from '../types';
import { extractProjectName, dirname } from '../utils/path-utils';

/**
 * Cursor transcript parser — stub implementation.
 * Cursor's transcript format is not yet publicly documented.
 * This parser detects Cursor files and creates an empty session
 * with a notice that full support is planned.
 */
export class CursorParser extends BaseParser {
	readonly format = 'cursor' as const;

	canParse(firstLines: string[]): boolean {
		for (const line of firstLines) {
			const record = this.tryParseJson(line);
			if (!record) continue;
			// Cursor uses a different structure — detect by known fields
			if (record['conversationId'] || record['cursorVersion']) {
				return true;
			}
		}
		return false;
	}

	parse(content: string, filePath: string): Session {
		const project = extractProjectName(dirname(filePath));

		return {
			metadata: {
				id: fileBasename(filePath),
				format: 'cursor',
				project,
				cwd: '',
				totalTurns: 0,
			},
			stats: {
				userTurns: 0, assistantTurns: 0,
				inputTokens: 0, outputTokens: 0,
				cacheReadTokens: 0, cacheCreationTokens: 0,
				toolUseCounts: {}, durationMs: 0,
			},
			turns: [],
			rawPath: filePath,
		};
	}
}

function fileBasename(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	const last = parts[parts.length - 1] || '';
	return last.replace(/\.\w+$/, '');
}
