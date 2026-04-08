import { Platform, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface ReadProgress {
	bytesRead: number;
	totalBytes: number;
}

/**
 * Read a file line-by-line. Uses Node.js streams on desktop,
 * falls back to full read on mobile.
 */
export async function readFileContent(
	filePath: string,
	onProgress?: (progress: ReadProgress) => void
): Promise<string> {
	if (Platform.isDesktop) {
		return readDesktop(filePath, onProgress);
	}
	// Mobile fallback — can't read arbitrary filesystem paths
	new Notice('On mobile, use vault files instead of filesystem paths.');
	throw new Error('Filesystem access is not available on mobile.');
}

async function readDesktop(
	filePath: string,
	onProgress?: (progress: ReadProgress) => void
): Promise<string> {
	const resolved = path.resolve(filePath);

	return new Promise((resolve, reject) => {
		let stat: { size: number };
		try {
			stat = fs.statSync(resolved);
		} catch {
			reject(new Error(`File not found: ${resolved}`));
			return;
		}

		const totalBytes = stat.size;
		let bytesRead = 0;
		const chunks: string[] = [];

		const stream = fs.createReadStream(resolved, { encoding: 'utf-8' });

		stream.on('data', (chunk: string) => {
			chunks.push(chunk);
			bytesRead += Buffer.byteLength(chunk, 'utf-8');
			if (onProgress) {
				onProgress({ bytesRead, totalBytes });
			}
		});

		stream.on('end', () => {
			resolve(chunks.join(''));
		});

		stream.on('error', (err: Error) => {
			reject(err);
		});
	});
}

export interface QuickMetadata {
	sessionId?: string;
	cwd?: string;
	startTime?: string;
	hasContent: boolean;
}

/** Substrings that identify large/irrelevant record types — skip without parsing. */
const SKIP_TYPE_STRINGS = [
	'"type":"file-history-snapshot"',
	'"type":"queue-operation"',
	'"type":"progress"',
];

/**
 * Read a JSONL file line-by-line and extract metadata from early records.
 * Skips large record types by prefix check to avoid parsing multi-KB JSON.
 * Stops once all fields are populated or after 100 lines. Desktop only.
 */
export async function extractQuickMetadataAsync(filePath: string): Promise<QuickMetadata> {
	if (!Platform.isDesktop) return { hasContent: false };

	const result: QuickMetadata = { hasContent: false };
	const MAX_LINES = 100;
	let lineCount = 0;

	return new Promise((resolve) => {
		const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		const cleanup = () => {
			rl.close();
			stream.destroy();
		};

		const isDone = () =>
			result.sessionId !== undefined
			&& result.cwd !== undefined
			&& result.startTime !== undefined
			&& result.hasContent;

		rl.on('line', (line: string) => {
			lineCount++;

			if (lineCount > MAX_LINES) {
				cleanup();
				return;
			}

			const trimmed = line.trim();
			if (!trimmed) return;

			// Skip large record types without full parsing — check substring within first 200 chars
			const head = trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
			for (const sub of SKIP_TYPE_STRINGS) {
				if (head.includes(sub)) return;
			}

			try {
				const record = JSON.parse(trimmed) as Record<string, unknown>;
				const recordType = record['type'] as string | undefined;

				if (recordType === 'user' || recordType === 'assistant') {
					result.hasContent = true;
				}

				if (typeof record['sessionId'] === 'string' && !result.sessionId) {
					result.sessionId = record['sessionId'];
				}
				if (typeof record['cwd'] === 'string' && !result.cwd) {
					result.cwd = record['cwd'];
				}
				if (typeof record['timestamp'] === 'string' && !result.startTime) {
					result.startTime = record['timestamp'];
				}
			} catch {
				// Malformed JSON — skip
			}

			if (isDone()) {
				cleanup();
			}
		});

		rl.on('close', () => {
			resolve(result);
		});

		stream.on('error', () => {
			resolve(result);
		});
	});
}

/**
 * List files in a directory. Desktop only.
 */
/**
 * List file names in a directory. Desktop only.
 * Returns just the file names (not full paths).
 */
export async function listDirectoryFiles(dirPath: string): Promise<string[]> {
	if (!Platform.isDesktop) return [];
	const resolved = path.resolve(dirPath);
	try {
		const entries = fs.readdirSync(resolved, { withFileTypes: true });
		return entries
			.filter((e: { isFile(): boolean }) => e.isFile())
			.map((e: { name: string }) => e.name);
	} catch {
		return [];
	}
}

export function listDirectory(dirPath: string): string[] {
	if (!Platform.isDesktop) return [];

	const resolved = path.resolve(dirPath);

	try {
		const entries = fs.readdirSync(resolved, { withFileTypes: true });
		return entries
			.filter((e: { isFile(): boolean; name: string }) =>
				e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')
			)
			.map((e: { name: string }) => path.join(resolved, e.name));
	} catch {
		return [];
	}
}

/**
 * List subdirectories. Desktop only.
 */
export function listSubdirectories(dirPath: string): string[] {
	if (!Platform.isDesktop) return [];

	const resolved = path.resolve(dirPath);

	try {
		const entries = fs.readdirSync(resolved, { withFileTypes: true });
		return entries
			.filter((e: { isDirectory(): boolean }) => e.isDirectory())
			.map((e: { name: string }) => path.join(resolved, e.name));
	} catch {
		return [];
	}
}
