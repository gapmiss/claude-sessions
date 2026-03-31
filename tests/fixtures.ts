/**
 * Inline JSONL fixture builders for parser tests.
 * Each function returns a multi-line string of JSONL records.
 */

/** Helper: build a JSONL string from an array of record objects. */
export function jsonl(...records: Record<string, unknown>[]): string {
	return records.map(r => JSON.stringify(r)).join('\n');
}

/** Minimal assistant record with a text block. */
export function assistantText(text: string, opts?: {
	uuid?: string;
	timestamp?: string;
	model?: string;
	msgId?: string;
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}): Record<string, unknown> {
	return {
		type: 'assistant',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:00:00.000Z',
		message: {
			role: 'assistant',
			model: opts?.model ?? 'claude-sonnet-4-20250514',
			id: opts?.msgId ?? `msg_${Math.random().toString(36).slice(2, 10)}`,
			content: [{ type: 'text', text }],
			...(opts?.usage ? { usage: opts.usage } : {}),
		},
	};
}

/** Assistant record with a thinking block. */
export function assistantThinking(thinking: string, opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'assistant',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:00:00.000Z',
		message: {
			role: 'assistant',
			model: 'claude-sonnet-4-20250514',
			content: [{ type: 'thinking', thinking }],
		},
	};
}

/** Assistant record with an encrypted thinking block (signature only, no text). */
export function assistantEncryptedThinking(opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'assistant',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:00:00.000Z',
		message: {
			role: 'assistant',
			model: 'claude-sonnet-4-20250514',
			content: [{ type: 'thinking', thinking: '', signature: 'abc123encrypted' }],
		},
	};
}

/** Assistant record with a tool_use block. */
export function assistantToolUse(name: string, id: string, input: Record<string, unknown>, opts?: {
	uuid?: string;
	timestamp?: string;
	msgId?: string;
}): Record<string, unknown> {
	return {
		type: 'assistant',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:00:00.000Z',
		message: {
			role: 'assistant',
			model: 'claude-sonnet-4-20250514',
			id: opts?.msgId,
			content: [{ type: 'tool_use', id, name, input }],
		},
	};
}

/** User record with actual text content. */
export function userText(text: string, opts?: {
	uuid?: string;
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:00.000Z',
		...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
		...(opts?.cwd ? { cwd: opts.cwd } : {}),
		message: {
			role: 'user',
			content: text,
		},
	};
}

/** User record with tool_result blocks (no user text). */
export function userToolResult(results: { toolUseId: string; content: string; isError?: boolean }[], opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:00:30.000Z',
		message: {
			role: 'user',
			content: results.map(r => ({
				type: 'tool_result',
				tool_use_id: r.toolUseId,
				content: r.content,
				is_error: r.isError ?? false,
			})),
		},
	};
}

/** Progress record with hook_progress data. */
export function hookProgress(toolUseID: string, hookEvent: string, hookName: string, opts?: {
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'progress',
		toolUseID,
		timestamp: opts?.timestamp ?? '2026-01-01T00:00:15.000Z',
		data: {
			type: 'hook_progress',
			hookEvent,
			hookName,
		},
	};
}

/** File history snapshot record (should be skipped). */
export function fileHistorySnapshot(): Record<string, unknown> {
	return {
		type: 'file-history-snapshot',
		uuid: crypto.randomUUID(),
		timestamp: '2026-01-01T00:00:00.000Z',
		snapshot: { files: ['/some/path'] },
	};
}

/** Sidechain record (should be skipped unless allowSidechain). */
export function sidechainAssistant(text: string, opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		...assistantText(text, opts),
		isSidechain: true,
	};
}

/** isMeta assistant record (should always be skipped). */
export function metaAssistant(text: string): Record<string, unknown> {
	return {
		...assistantText(text),
		isMeta: true,
	};
}

/** User record invoking a slash command (e.g. /wrap or /context). */
export function userSlashCommand(command: string, opts?: {
	uuid?: string;
	timestamp?: string;
	commandMessage?: string;
}): Record<string, unknown> {
	const msg = opts?.commandMessage ?? command.replace(/^\//, '');
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:00.000Z',
		message: {
			role: 'user',
			content: `<command-message>${msg}</command-message>\n<command-name>${command}</command-name>`,
		},
	};
}

/** isMeta user record with skill expansion text (follows a slash command). */
export function metaSkillExpansion(text: string, opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:00.000Z',
		isMeta: true,
		message: {
			role: 'user',
			content: [{ type: 'text', text }],
		},
	};
}

/** Synthetic model record (should be skipped). */
export function syntheticAssistant(text: string): Record<string, unknown> {
	const rec = assistantText(text);
	(rec.message as Record<string, unknown>).model = '<synthetic>';
	return rec;
}

/** User record with bash command input (user-typed shell command). */
export function userBashInput(command: string, opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:00.000Z',
		message: {
			role: 'user',
			content: `<bash-input>${command}</bash-input>`,
		},
	};
}

/** User record with bash command output (stdout + stderr). */
export function userBashOutput(stdout: string, stderr = '', opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:01.000Z',
		message: {
			role: 'user',
			content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`,
		},
	};
}

/** isMeta user record with local-command-caveat (already filtered by isMeta). */
export function userBashCaveat(opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:00.000Z',
		isMeta: true,
		message: {
			role: 'user',
			content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
		},
	};
}

/** User record with interruption message. */
export function userInterruption(opts?: {
	uuid?: string;
	timestamp?: string;
}): Record<string, unknown> {
	return {
		type: 'user',
		uuid: opts?.uuid ?? crypto.randomUUID(),
		timestamp: opts?.timestamp ?? '2026-01-01T00:01:00.000Z',
		message: {
			role: 'user',
			content: '[Request interrupted by user] some context',
		},
	};
}
