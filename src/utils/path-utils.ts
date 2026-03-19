import { Platform, normalizePath } from 'obsidian';

export function expandHome(path: string): string {
	if (!path.startsWith('~')) return path;
	if (Platform.isDesktop) {
		try {
			const os = require('os') as { homedir(): string };
			return path.replace(/^~/, os.homedir());
		} catch {
			return path;
		}
	}
	return path;
}

export function safeNormalize(path: string): string {
	return normalizePath(path);
}

export function basename(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	return parts[parts.length - 1] || '';
}

export function dirname(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash === -1) return '.';
	return normalized.substring(0, lastSlash);
}

export function extractProjectName(dirPath: string): string {
	const parts = dirPath.replace(/\\/g, '/').split('/').filter(Boolean);
	// Claude projects dirs are encoded like -Users-gm-myproject
	const last = parts[parts.length - 1] || 'unknown';
	if (last.startsWith('-')) {
		const decoded = last.split('-').filter(Boolean);
		return decoded[decoded.length - 1] || last;
	}
	return last;
}
