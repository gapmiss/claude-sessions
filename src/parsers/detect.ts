import { BaseParser } from './base-parser';
import { ClaudeParser } from './claude-parser';
import { CursorParser } from './cursor-parser';
import { CodexParser } from './codex-parser';

const parsers: BaseParser[] = [
	new ClaudeParser(),
	new CursorParser(),
	new CodexParser(),
];

export function detectParser(content: string): BaseParser | null {
	const lines = content.split('\n').filter(l => l.trim().length > 0).slice(0, 10);
	if (lines.length === 0) return null;

	for (const parser of parsers) {
		if (parser.canParse(lines)) return parser;
	}
	return null;
}

export function getParserByName(name: string): BaseParser | null {
	return parsers.find(p => p.format === name) ?? null;
}
