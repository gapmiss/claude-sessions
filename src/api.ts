/**
 * Public API for inter-plugin communication.
 *
 * Other plugins can access this API via:
 * ```typescript
 * const api = app.plugins.plugins['claude-sessions']?.api as ClaudeSessionsAPI;
 * ```
 */

import type { Session, SessionListEntry } from './types';

/**
 * Public API surface for the Claude Sessions plugin.
 * Designed to be stable — additions are fine, removals are breaking.
 */
export interface ClaudeSessionsAPI {
	/**
	 * Get the parsed Session from the active timeline view, if any.
	 * Returns null if no timeline view is active or no session is loaded.
	 */
	getActiveSession(): Session | null;

	/**
	 * Parse a JSONL file at the given absolute path.
	 * Throws if the file cannot be read or parsed.
	 */
	parseSessionFile(path: string): Promise<Session>;

	/**
	 * Register a callback for when a session is parsed/refreshed.
	 * Called whenever a timeline view loads or reloads a session.
	 * Returns an unsubscribe function.
	 */
	onSessionParsed(callback: (session: Session) => void): () => void;

	/**
	 * Get all indexed session entries (lightweight metadata, no full parse).
	 * Triggers a scan if the index is empty.
	 */
	getSessionIndex(): Promise<SessionListEntry[]>;
}

/**
 * Internal interface for the plugin instance.
 * Used by buildAPI to access plugin methods.
 */
interface PluginInstance {
	getActiveTimelineView(): { getSession(): Session | null } | null;
	sessionIndex: {
		load(): Promise<void>;
		get(path: string): unknown;
	};
	settings: {
		sessionDirs: string[];
	};
	app: {
		vault: {
			adapter: {
				read(path: string): Promise<string>;
			};
		};
	};
}

// Event emitter for session parsed events
type SessionCallback = (session: Session) => void;
const sessionParsedCallbacks = new Set<SessionCallback>();

/**
 * Emit a session parsed event (called by TimelineView).
 */
export function emitSessionParsed(session: Session): void {
	for (const cb of sessionParsedCallbacks) {
		try {
			cb(session);
		} catch {
			// Ignore callback errors
		}
	}
}

/**
 * Build the public API object from a plugin instance.
 */
export function buildAPI(plugin: PluginInstance): ClaudeSessionsAPI {
	// Lazy import to avoid circular dependency
	let ClaudeParser: typeof import('./parsers/claude-parser').ClaudeParser | null = null;

	return {
		getActiveSession(): Session | null {
			const view = plugin.getActiveTimelineView();
			return view?.getSession() ?? null;
		},

		async parseSessionFile(path: string): Promise<Session> {
			// Lazy load parser
			if (!ClaudeParser) {
				const mod = await import('./parsers/claude-parser');
				ClaudeParser = mod.ClaudeParser;
			}

			const content = await plugin.app.vault.adapter.read(path);
			const parser = new ClaudeParser();
			return parser.parse(content, path);
		},

		onSessionParsed(callback: SessionCallback): () => void {
			sessionParsedCallbacks.add(callback);
			return () => {
				sessionParsedCallbacks.delete(callback);
			};
		},

		async getSessionIndex(): Promise<SessionListEntry[]> {
			// Import scanner lazily
			const { scanSessionDirs } = await import('./views/session-browser-modal');
			const result = await scanSessionDirs(plugin as unknown as Parameters<typeof scanSessionDirs>[0]);
			return result.entries;
		},
	};
}
