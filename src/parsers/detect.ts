import { BaseParser } from './base-parser';
import { ClaudeParser } from './claude-parser';

const parsers: BaseParser[] = [
	new ClaudeParser(),
];

export function detectParser(content: string): BaseParser | null {
	// L4: Increased from 10 to 20 lines — first 10 may all be system/metadata records
	const lines = content.split('\n').filter(l => l.trim().length > 0).slice(0, 20);
	if (lines.length === 0) return null;

	for (const parser of parsers) {
		if (parser.canParse(lines)) return parser;
	}
	return null;
}

