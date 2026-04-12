import { ClaudeParser } from './claude-parser';
import type { Session, ToolUseBlock } from '../types';
import {
	RE_TN_TOOL_USE_ID, RE_TN_TASK_ID, RE_TN_RESULT, RE_TN_SUMMARY, RE_TN_DURATION,
	BT_TOOL_USE, SUBAGENT_TOOL_NAMES,
} from '../constants';
import { Logger } from '../utils/logger';

/** H1: Timeout for sub-agent file reads (ms). */
const READ_TIMEOUT_MS = 5000;

/** Wrap a promise with a timeout. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(`Timeout reading ${label}`)), ms);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		clearTimeout(timeoutId!);
	}
}

/** Parse <task-notification> XML from queue-operation or user records. */
export function parseTaskNotification(
	content: string,
): { taskId: string; toolUseId: string; result: string; summary: string; durationMs?: number } | null {
	const toolUseId = content.match(RE_TN_TOOL_USE_ID)?.[1]?.trim();
	if (!toolUseId) return null;
	const taskId = content.match(RE_TN_TASK_ID)?.[1]?.trim() ?? '';
	const summary = content.match(RE_TN_SUMMARY)?.[1]?.trim() ?? '';
	const result = content.match(RE_TN_RESULT)?.[1]?.trim() ?? '';
	const durationRaw = content.match(RE_TN_DURATION)?.[1]?.trim();
	const durationMs = durationRaw ? parseInt(durationRaw, 10) : undefined;
	return { taskId, toolUseId, result, summary, durationMs: (durationMs && !isNaN(durationMs)) ? durationMs : undefined };
}

/** Read and parse JSON, returning null on failure. */
function tryParseJson(text: string): Record<string, unknown> | null {
	try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
}

/**
 * Resolve sub-agent sessions by reading their JSONL files.
 * Both background and foreground agents have full JSONL files at
 * <sessionBase>/subagents/agent-<agentId>.jsonl.
 *
 * For agents without an agentId (e.g. foreground Explore agents whose
 * tool_result text doesn't include the ID), we scan the subagents/
 * directory and match via .meta.json description fields.
 */
export async function resolveSubAgentSessions(
	session: Session,
	readFile: (path: string) => Promise<string>,
	listFiles?: (dir: string) => Promise<string[]>,
): Promise<void> {
	const sessionBase = session.rawPath.replace(/\.jsonl$/, '');
	const subagentsDir = `${sessionBase}/subagents`;
	const parser = new ClaudeParser({ allowSidechain: true });

	// Collect all Agent blocks that need resolution
	const withId: { agentId: string; block: ToolUseBlock }[] = [];
	const withoutId: { description: string; block: ToolUseBlock }[] = [];
	const resolvedIds = new Set<string>();

	for (const turn of session.turns) {
		for (const block of turn.contentBlocks) {
			if (block.type === BT_TOOL_USE
				&& SUBAGENT_TOOL_NAMES.has(block.name)
				&& block.subAgentSession) {
				if (block.subAgentSession.agentId) {
					withId.push({ agentId: block.subAgentSession.agentId, block });
				} else {
					withoutId.push({
						description: block.subAgentSession.description ?? '',
						block,
					});
				}
			}
		}
	}

	// Resolve blocks that already have an agentId
	for (const { agentId, block } of withId) {
		const subagentPath = `${subagentsDir}/agent-${agentId}.jsonl`;
		try {
			const content = await withTimeout(readFile(subagentPath), READ_TIMEOUT_MS, subagentPath);
			const subSession = parser.parse(content, subagentPath);
			block.subAgentSession!.turns = subSession.turns;
			resolvedIds.add(agentId);
		} catch (err) {
			// M3: Distinguish file-not-found (expected) from other errors
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('ENOENT') || msg.includes('not found')) {
				Logger.debug(`Sub-agent file not found (agent may be running): ${subagentPath}`);
			} else {
				Logger.warn(`Failed to read sub-agent file: ${subagentPath}`, err);
			}
		}
	}

	// For blocks without agentId, scan the subagents directory and match via meta
	if (withoutId.length > 0 && listFiles) {
		try {
			const files = await listFiles(subagentsDir);
			const metaFiles = files.filter(f => f.endsWith('.meta.json'));

			// Build a map of description → agentId from unresolved meta files
			const descriptionToId = new Map<string, string>();
			for (const metaFile of metaFiles) {
				const agentId = metaFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
				if (resolvedIds.has(agentId)) continue;
				const metaPath = `${subagentsDir}/${metaFile}`;
				try {
					const metaContent = await withTimeout(readFile(metaPath), READ_TIMEOUT_MS, metaPath);
					const meta = tryParseJson(metaContent);
					if (meta && typeof meta.description === 'string') {
						descriptionToId.set(meta.description, agentId);
					}
				} catch (err) {
					// M3: Log meta file read failures for diagnostics
					Logger.debug(`Failed to read sub-agent meta: ${metaPath}`, err);
				}
			}

			// Match unresolved blocks by description
			for (const { description, block } of withoutId) {
				const agentId = descriptionToId.get(description);
				if (!agentId) continue;
				const subagentPath = `${subagentsDir}/agent-${agentId}.jsonl`;
				try {
					const content = await withTimeout(readFile(subagentPath), READ_TIMEOUT_MS, subagentPath);
					const subSession = parser.parse(content, subagentPath);
					block.subAgentSession!.agentId = agentId;
					block.subAgentSession!.turns = subSession.turns;
					descriptionToId.delete(description);
					resolvedIds.add(agentId);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (!msg.includes('ENOENT') && !msg.includes('not found')) {
						Logger.warn(`Failed to read sub-agent file: ${subagentPath}`, err);
					}
				}
			}
		} catch (err) {
			// subagents directory may not exist — expected for sessions without agents
			Logger.debug('Sub-agents directory not found or inaccessible', err);
		}
	}
}
