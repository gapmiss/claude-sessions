import { Platform, Notice } from 'obsidian';

export interface ReadProgress {
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
	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');

	const resolved = path.resolve(filePath);

	return new Promise((resolve, reject) => {
		let stat: { size: number };
		try {
			stat = fs.statSync(resolved);
		} catch (e) {
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

/**
 * List files in a directory. Desktop only.
 */
export async function listDirectory(dirPath: string): Promise<string[]> {
	if (!Platform.isDesktop) return [];

	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');

	const resolved = path.resolve(dirPath);

	try {
		const entries = fs.readdirSync(resolved, { withFileTypes: true });
		return entries
			.filter((e: { isFile(): boolean; name: string }) =>
				e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))
			)
			.map((e: { name: string }) => path.join(resolved, e.name));
	} catch {
		return [];
	}
}

/**
 * List subdirectories. Desktop only.
 */
export async function listSubdirectories(dirPath: string): Promise<string[]> {
	if (!Platform.isDesktop) return [];

	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');

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
