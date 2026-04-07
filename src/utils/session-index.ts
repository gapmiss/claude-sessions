import type { CachedSessionMeta, SessionIndexData } from '../types';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_VERSION = 1;
const INDEX_FILENAME = 'session-index.json';

export class SessionIndex {
	private entries: Record<string, CachedSessionMeta> = {};
	private loaded = false;
	private indexPath: string;

	constructor(vaultBasePath: string, configDir: string) {
		this.indexPath = path.join(
			vaultBasePath,
			configDir,
			'plugins',
			'claude-sessions',
			INDEX_FILENAME,
		);
	}

	load(): void {
		if (this.loaded) return;
		this.loaded = true;

		try {
			const raw = fs.readFileSync(this.indexPath, 'utf-8');
			const data = JSON.parse(raw) as SessionIndexData;
			if (data.version === INDEX_VERSION && data.entries) {
				this.entries = data.entries;
			}
		} catch {
			// Missing or corrupt — start fresh
			this.entries = {};
		}
	}

	get(filePath: string, mtime: number): CachedSessionMeta | null {
		const cached = this.entries[filePath];
		if (cached && cached.mtime === mtime) return cached;
		return null;
	}

	set(filePath: string, meta: CachedSessionMeta): void {
		this.entries[filePath] = meta;
	}

	prune(validPaths: Set<string>): number {
		let pruned = 0;
		for (const key of Object.keys(this.entries)) {
			if (!validPaths.has(key)) {
				delete this.entries[key];
				pruned++;
			}
		}
		return pruned;
	}

	save(): void {
		const data: SessionIndexData = {
			version: INDEX_VERSION,
			entries: this.entries,
		};
		try {
			fs.writeFileSync(this.indexPath, JSON.stringify(data), 'utf-8');
		} catch {
			// Plugin directory may not exist yet — ignore
		}
	}
}
