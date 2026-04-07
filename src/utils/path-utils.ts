import { Platform } from 'obsidian';
import * as os from 'os';

export function expandHome(path: string): string {
	if (!path.startsWith('~')) return path;
	if (Platform.isDesktop) {
		try {
			return path.replace(/^~/, os.homedir());
		} catch {
			return path;
		}
	}
	return path;
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

export function shortenPath(fullPath: string): string {
	if (Platform.isDesktop) {
		try {
			const home = os.homedir();
			if (fullPath.startsWith(home)) {
				return '~' + fullPath.slice(home.length);
			}
		} catch {
			// Fall through
		}
	}
	return fullPath;
}

export function projectFromCwd(cwd: string): string {
	return basename(cwd) || 'unknown';
}

export function extractProjectName(dirPath: string): string {
	const parts = dirPath.replace(/\\/g, '/').split('/').filter(Boolean);
	// Claude session dirs encode cwd as e.g. -Users-gm-claude-sessions
	// This is lossy: hyphens in dir names are indistinguishable from path separators
	// Prefer projectFromCwd() with the real cwd when available
	const last = parts[parts.length - 1] || 'unknown';
	if (last.startsWith('-')) {
		const decoded = last.split('-').filter(Boolean);
		return decoded[decoded.length - 1] || last;
	}
	return last;
}
