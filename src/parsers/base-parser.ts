import { Session, SessionFormat } from '../types';
import { Logger } from '../utils/logger';

/** Maximum line size to parse (10 MB). Lines exceeding this are skipped to prevent memory exhaustion. */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

export abstract class BaseParser {
	abstract readonly format: SessionFormat;

	abstract canParse(firstLines: string[]): boolean;

	abstract parse(content: string, filePath: string): Session;

	/** Parse error count for diagnostics. Reset per-file in parse(). */
	protected parseErrorCount = 0;

	protected splitLines(content: string): string[] {
		// Normalize line endings: CRLF → LF, CR → LF
		const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		// Strip UTF-8 BOM if present
		const stripped = normalized.startsWith('\ufeff') ? normalized.slice(1) : normalized;
		return stripped.split('\n').filter(line => line.trim().length > 0);
	}

	protected tryParseJson(line: string): Record<string, unknown> | null {
		// U1: Size guard — skip lines > 10MB to prevent memory exhaustion
		if (line.length > MAX_LINE_BYTES) {
			Logger.warn(`Skipping oversized JSONL line (${(line.length / 1024 / 1024).toFixed(1)} MB)`);
			this.parseErrorCount++;
			return null;
		}
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch (e) {
			this.parseErrorCount++;
			Logger.debug('JSONL parse error on line: ' + line.slice(0, 80), e);
			return null;
		}
	}

	protected formatTimestamp(ts: string | undefined): string | undefined {
		if (!ts) return undefined;
		try {
			return new Date(ts).toISOString();
		} catch {
			return ts;
		}
	}
}
