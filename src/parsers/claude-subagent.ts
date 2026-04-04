import { ClaudeParser } from './claude-parser';
import type { Session } from '../types';
import {
	RE_TN_TOOL_USE_ID, RE_TN_TASK_ID, RE_TN_RESULT, RE_TN_SUMMARY, RE_TN_DURATION,
	BT_TOOL_USE,
} from '../constants';

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

/**
 * Resolve sub-agent sessions by reading their JSONL files.
 * Both background and foreground agents have full JSONL files at
 * <sessionBase>/subagents/agent-<agentId>.jsonl.
 */
export async function resolveSubAgentSessions(
	session: Session,
	readFile: (path: string) => Promise<string>,
): Promise<void> {
	const sessionBase = session.rawPath.replace(/\.jsonl$/, '');
	const parser = new ClaudeParser({ allowSidechain: true });

	for (const turn of session.turns) {
		for (const block of turn.contentBlocks) {
			if (block.type === BT_TOOL_USE
				&& block.subAgentSession
				&& block.subAgentSession.agentId) {
				const subagentPath = `${sessionBase}/subagents/agent-${block.subAgentSession.agentId}.jsonl`;
				try {
					const content = await readFile(subagentPath);
					const subSession = parser.parse(content, subagentPath);
					block.subAgentSession.turns = subSession.turns;
				} catch {
					// Subagent file may not exist yet if agent is still running
				}
			}
		}
	}
}
