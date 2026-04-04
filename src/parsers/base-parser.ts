import { Session, SessionFormat } from '../types';
import { Logger } from '../utils/logger';

export abstract class BaseParser {
	abstract readonly format: SessionFormat;

	abstract canParse(firstLines: string[]): boolean;

	abstract parse(content: string, filePath: string): Session;

	protected splitLines(content: string): string[] {
		return content.split('\n').filter(line => line.trim().length > 0);
	}

	protected tryParseJson(line: string): Record<string, unknown> | null {
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch (e) {
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
