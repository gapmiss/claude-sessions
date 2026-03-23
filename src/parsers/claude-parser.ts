import { BaseParser } from './base-parser';
import {
	Session, Turn, ContentBlock, TextBlock, ThinkingBlock,
	ToolUseBlock, ToolResultBlock, ImageBlock, AnsiBlock, CompactionBlock,
	HookEvent, SessionStats, SubAgentSession,
} from '../types';
import { extractProjectName, dirname } from '../utils/path-utils';

interface ClaudeRecord {
	type: string;
	subtype?: string;
	content?: string;
	uuid?: string;
	parentUuid?: string | null;
	sessionId?: string;
	cwd?: string;
	version?: string;
	gitBranch?: string;
	timestamp?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	toolUseID?: string;
	parentToolUseID?: string;
	isCompactSummary?: boolean;
	summary?: string;
	operation?: string;
	sourceToolUseID?: string;
	toolUseResult?: Record<string, unknown>;
	data?: {
		type?: string;
		hookEvent?: string;
		hookName?: string;
		// agent_progress fields
		agentId?: string;
		prompt?: string;
		message?: {
			type?: string;
			uuid?: string;
			timestamp?: string;
			message?: {
				role?: string;
				model?: string;
				id?: string;
				content?: string | ClaudeContentBlock[];
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					cache_read_input_tokens?: number;
					cache_creation_input_tokens?: number;
				};
			};
		};
	};
	message?: {
		role?: string;
		content?: string | ClaudeContentBlock[];
		model?: string;
		stop_reason?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
}

interface ClaudeContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | ToolResultContent[];
	is_error?: boolean;
	source?: {
		type?: string;
		media_type?: string;
		data?: string;
	};
}

interface ToolResultContent {
	type: string;
	tool_use_id?: string;
	content?: string;
	text?: string;
	is_error?: boolean;
}

const SKIP_TYPES = new Set([
	'file-history-snapshot',
	'progress',
	'queue-operation',
]);

export class ClaudeParser extends BaseParser {
	readonly format = 'claude' as const;
	/** When true, isSidechain records are not skipped (for subagent files). */
	private readonly allowSidechain: boolean;

	constructor(opts?: { allowSidechain?: boolean }) {
		super();
		this.allowSidechain = opts?.allowSidechain ?? false;
	}

	canParse(firstLines: string[]): boolean {
		for (const line of firstLines) {
			const record = this.tryParseJson(line);
			if (!record) continue;
			const type = record['type'] as string | undefined;
			if (type === 'user' || type === 'assistant') {
				const msg = record['message'] as Record<string, unknown> | undefined;
				if (msg && ('role' in msg)) return true;
			}
			if (type === 'file-history-snapshot' || record['sessionId']) return true;
		}
		return false;
	}

	parse(content: string, filePath: string): Session {
		const lines = this.splitLines(content);
		const records: ClaudeRecord[] = [];
		let sessionId = '';
		let cwd = '';
		let version = '';
		let branch = '';
		let model = '';
		let startTime = '';

		// Collect hook events by toolUseID
		const hookMap = new Map<string, HookEvent[]>();

		// Collect sub-agent progress records by parentToolUseID
		const agentProgressMap = new Map<string, ClaudeRecord[]>();

		// Token usage per message ID (keep max of each field across streaming duplicates)
		const usageByMsg = new Map<string, { inp: number; out: number; cr: number; cc: number }>();

		// Enriched tool results by sourceToolUseID
		const enrichedResults = new Map<string, Record<string, unknown>>();

		// Collect task-notification results for background agents (keyed by tool-use-id)
		const taskNotifications = new Map<string, { taskId: string; toolUseId: string; result: string; summary: string }>();

		// First pass: parse all records and extract metadata
		for (const line of lines) {
			const record = this.tryParseJson(line) as ClaudeRecord | null;
			if (!record) continue;

			// Capture hook_progress before skipping progress records
			if (record.type === 'progress' && record.data?.type === 'hook_progress'
				&& record.toolUseID && record.data.hookEvent && record.data.hookName) {
				const hooks = hookMap.get(record.toolUseID) ?? [];
				hooks.push({
					hookEvent: record.data.hookEvent,
					hookName: record.data.hookName,
					timestamp: record.timestamp,
				});
				hookMap.set(record.toolUseID, hooks);
			}

			// Capture agent_progress records for sub-agent rendering
			if (record.type === 'progress' && record.data?.type === 'agent_progress'
				&& record.parentToolUseID) {
				const group = agentProgressMap.get(record.parentToolUseID) ?? [];
				group.push(record);
				agentProgressMap.set(record.parentToolUseID, group);
			}

			// Track max token usage per message ID (streaming produces duplicates)
			if (record.type === 'assistant' && record.message?.usage) {
				const msgId = (record.message as Record<string, unknown>)['id'] as string | undefined;
				if (msgId) {
					const u = record.message.usage;
					const prev = usageByMsg.get(msgId);
					usageByMsg.set(msgId, {
						inp: Math.max(prev?.inp ?? 0, u.input_tokens ?? 0),
						out: Math.max(prev?.out ?? 0, u.output_tokens ?? 0),
						cr: Math.max(prev?.cr ?? 0, u.cache_read_input_tokens ?? 0),
						cc: Math.max(prev?.cc ?? 0, u.cache_creation_input_tokens ?? 0),
					});
				}
			}

			// Capture enriched toolUseResult from user entries
			if (record.type === 'user' && record.toolUseResult && record.sourceToolUseID) {
				enrichedResults.set(record.sourceToolUseID, record.toolUseResult);
			}

			// Capture task-notification results from queue-operation and user records
			// before they are skipped — these carry background agent completion data
			if (record.type === 'queue-operation' && record.content?.startsWith('<task-notification>')) {
				const tn = ClaudeParser.parseTaskNotification(record.content);
				if (tn) taskNotifications.set(tn.toolUseId, tn);
			}
			if (record.type === 'user' && typeof record.message?.content === 'string'
				&& record.message.content.startsWith('<task-notification>')) {
				const tn = ClaudeParser.parseTaskNotification(record.message.content);
				if (tn) taskNotifications.set(tn.toolUseId, tn);
			}

			if (record.type === 'queue-operation' && record.operation === 'enqueue' && record.content) {
				// Enqueue records carry user messages — let them through
			} else if (SKIP_TYPES.has(record.type)) continue;
			if (record.isSidechain && !this.allowSidechain) continue;
			if (record.isMeta) continue;
			if (record.type === 'assistant' && record.message?.model === '<synthetic>') continue;

			// Let summary records through for compaction boundary rendering
			if (record.type === 'summary') {
				records.push(record);
				continue;
			}

			if (record.sessionId && !sessionId) sessionId = record.sessionId;
			if (record.cwd && !cwd) cwd = record.cwd;
			if (record.version && !version) version = record.version;
			if (record.gitBranch && !branch) branch = record.gitBranch;
			if (record.timestamp && !startTime) startTime = record.timestamp;
			if (record.message?.model && !model) model = record.message.model;

			records.push(record);
		}

		// Deduplicate by uuid — keep the most complete (last) record
		const byUuid = new Map<string, ClaudeRecord>();
		const ordered: ClaudeRecord[] = [];
		for (const record of records) {
			if (record.uuid) {
				if (byUuid.has(record.uuid)) {
					// Replace with newer version (more content)
					const idx = ordered.indexOf(byUuid.get(record.uuid)!);
					if (idx !== -1) ordered[idx] = record;
				} else {
					ordered.push(record);
				}
				byUuid.set(record.uuid, record);
			} else {
				ordered.push(record);
			}
		}

		// Second pass: build turns from deduplicated records
		const turns = this.buildTurns(ordered);

		// Attach hook events to their corresponding tool_use blocks
		if (hookMap.size > 0) {
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === 'tool_use' && hookMap.has(block.id)) {
						block.hooks = hookMap.get(block.id);
					}
				}
			}
		}

		// Attach sub-agent sessions to their corresponding Agent tool_use blocks
		if (agentProgressMap.size > 0) {
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === 'tool_use'
						&& (block.name === 'Agent' || block.name === 'Task')
						&& agentProgressMap.has(block.id)) {
						const agentRecords = agentProgressMap.get(block.id)!;
						block.subAgentSession = this.buildSubAgentSession(agentRecords, block);
					}
				}
			}
		}

		// Attach task-notification results to background Agent/Task blocks
		// Background agents (run_in_background: true) don't produce agent_progress records;
		// their output arrives via <task-notification> in queue-operation/user records.
		if (taskNotifications.size > 0) {
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === 'tool_use'
						&& (block.name === 'Agent' || block.name === 'Task')
						&& !block.subAgentSession
						&& taskNotifications.has(block.id)) {
						const tn = taskNotifications.get(block.id)!;
						block.subAgentSession = {
							agentId: tn.taskId,
							description: String(block.input['description'] || ''),
							subagentType: String(block.input['subagent_type'] || ''),
							prompt: String(block.input['prompt'] || ''),
							turns: [],
							isBackground: true,
						};
					}
					// Replace the "Async agent launched successfully" tool_result
					// with the actual notification result
					if (block.type === 'tool_result' && taskNotifications.has(block.toolUseId)) {
						block.content = taskNotifications.get(block.toolUseId)!.result;
					}
				}
			}
		}

		// Attach enriched results and mark orphaned tool_use blocks
		const resultIds = new Set<string>();
		for (const turn of turns) {
			for (const block of turn.contentBlocks) {
				if (block.type === 'tool_result') {
					resultIds.add(block.toolUseId);
					if (enrichedResults.has(block.toolUseId)) {
						block.enrichedResult = enrichedResults.get(block.toolUseId);
					}
				}
			}
		}
		// Find the last assistant turn to distinguish pending vs interrupted
		let lastAssistantTurn: Turn | undefined;
		for (let i = turns.length - 1; i >= 0; i--) {
			if (turns[i].role === 'assistant') { lastAssistantTurn = turns[i]; break; }
		}
		for (const turn of turns) {
			for (const block of turn.contentBlocks) {
				if (block.type === 'tool_use' && !resultIds.has(block.id)) {
					if (turn === lastAssistantTurn) {
						block.isPending = true;
					} else {
						block.isOrphaned = true;
					}
				}
			}
		}

		const project = extractProjectName(dirname(filePath));

		// Compute stats
		const toolUseCounts: Record<string, number> = {};
		let userTurns = 0;
		let assistantTurns = 0;
		for (const turn of turns) {
			if (turn.role === 'user') userTurns++;
			else assistantTurns++;
			for (const block of turn.contentBlocks) {
				if (block.type === 'tool_use') {
					toolUseCounts[block.name] = (toolUseCounts[block.name] ?? 0) + 1;
				}
			}
		}

		// Duration from first to last timestamp
		let durationMs = 0;
		if (turns.length > 0) {
			const first = turns[0].timestamp;
			const lastTurn = turns[turns.length - 1];
			const last = lastTurn.endTimestamp ?? lastTurn.timestamp;
			if (first && last) {
				durationMs = new Date(last).getTime() - new Date(first).getTime();
			}
		}

		// Sum token usage across all unique messages
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCacheCreationTokens = 0;
		for (const u of usageByMsg.values()) {
			totalInputTokens += u.inp;
			totalOutputTokens += u.out;
			totalCacheReadTokens += u.cr;
			totalCacheCreationTokens += u.cc;
		}

		const stats: SessionStats = {
			userTurns,
			assistantTurns,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: totalCacheReadTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			totalTokens: totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheCreationTokens,
			toolUseCounts,
			durationMs,
		};

		return {
			metadata: {
				id: sessionId || basename(filePath),
				format: 'claude',
				project,
				cwd,
				branch: branch || undefined,
				model: model || undefined,
				version: version || undefined,
				startTime: this.formatTimestamp(startTime),
				totalTurns: turns.length,
			},
			stats,
			turns,
			rawPath: filePath,
		};
	}

	/**
	 * Build turns by merging consecutive same-role records.
	 * Claude streams assistant responses as multiple records (thinking, text, tool_use),
	 * each with its own uuid. These should form a single assistant turn.
	 * User records containing only tool_result blocks should have those results
	 * attached to the preceding assistant turn (not become separate user turns).
	 */
	private buildTurns(ordered: ClaudeRecord[]): Turn[] {
		const turns: Turn[] = [];
		const toolUseNames = new Map<string, string>();
		let currentAssistantTurn: Turn | null = null;

		const flushAssistant = () => {
			if (currentAssistantTurn && currentAssistantTurn.contentBlocks.length > 0) {
				currentAssistantTurn.index = turns.length;
				turns.push(currentAssistantTurn);
			}
			currentAssistantTurn = null;
		};

		for (const record of ordered) {
			// Queue-operation enqueue → user turn with the queued message
			if (record.type === 'queue-operation' && record.operation === 'enqueue' && record.content) {
				// Skip system-injected task notifications
				if (record.content.startsWith('<task-notification>')) continue;
				flushAssistant();
				const ts = this.formatTimestamp(record.timestamp);
				turns.push({
					index: turns.length,
					role: 'user',
					timestamp: ts,
					endTimestamp: ts,
					contentBlocks: [{
						type: 'text',
						text: record.content,
						timestamp: record.timestamp,
					} as TextBlock],
				});
				continue;
			}

			// Summary records → compaction boundary
			if (record.type === 'summary') {
				flushAssistant();
				const ts = this.formatTimestamp(record.timestamp);
				turns.push({
					index: turns.length,
					role: 'assistant',
					timestamp: ts,
					endTimestamp: ts,
					contentBlocks: [{
						type: 'compaction',
						summary: record.summary,
						timestamp: record.timestamp,
					} as CompactionBlock],
				});
				continue;
			}

			// System records with local_command subtype (slash commands like /rename)
			if (record.type === 'system' && record.subtype === 'local_command' && record.content) {
				const blocks = this.extractSystemContent(record);
				if (blocks.length > 0) {
					flushAssistant();
					const ts = this.formatTimestamp(record.timestamp);
					turns.push({
						index: turns.length,
						role: 'user',
						timestamp: ts,
						endTimestamp: ts,
						contentBlocks: blocks,
					});
				}
				continue;
			}

			if (record.type === 'assistant') {
				const blocks = this.parseAssistantBlocks(record, toolUseNames);
				if (blocks.length === 0) continue;

				if (!currentAssistantTurn) {
					currentAssistantTurn = {
						index: 0,
						role: 'assistant',
						timestamp: this.formatTimestamp(record.timestamp),
						endTimestamp: this.formatTimestamp(record.timestamp),
						contentBlocks: [],
					};
				}
				if (record.timestamp) {
					currentAssistantTurn.endTimestamp = this.formatTimestamp(record.timestamp);
				}
				if (record.message?.model && record.message.model !== '<synthetic>'
					&& !currentAssistantTurn.model) {
					currentAssistantTurn.model = record.message.model;
				}
				if (record.message?.stop_reason) {
					currentAssistantTurn.stopReason = record.message.stop_reason;
				}
				for (const b of blocks) {
					currentAssistantTurn.contentBlocks.push(b);
				}
			} else if (record.type === 'user') {
				// isCompactSummary user entries → compaction boundary
				if (record.isCompactSummary) {
					flushAssistant();
					const ts = this.formatTimestamp(record.timestamp);
					turns.push({
						index: turns.length,
						role: 'assistant',
						timestamp: ts,
						endTimestamp: ts,
						contentBlocks: [{
							type: 'compaction',
							timestamp: record.timestamp,
						} as CompactionBlock],
					});
					continue;
				}

				// Skip task notification messages (system-injected, not user-typed)
				if (typeof record.message?.content === 'string'
					&& record.message.content.startsWith('<task-notification>')) {
					continue;
				}

				// Interruption messages attach to assistant turn, not separate user turn
				if (this.isInterruptionMessage(record)) {
					if (currentAssistantTurn) {
						currentAssistantTurn.contentBlocks.push({
							type: 'text',
							text: '*Request interrupted by user*',
							timestamp: record.timestamp,
						} as TextBlock);
						if (record.timestamp) {
							currentAssistantTurn.endTimestamp = this.formatTimestamp(record.timestamp);
						}
					}
					continue;
				}

				const toolResults = this.extractToolResultBlocks(record, toolUseNames);

				if (toolResults.length > 0 && currentAssistantTurn) {
					for (const result of toolResults) {
						currentAssistantTurn.contentBlocks.push(result);
					}
					if (record.timestamp) {
						currentAssistantTurn.endTimestamp = this.formatTimestamp(record.timestamp);
					}
				} else if (toolResults.length > 0) {
					const lastAssistant = this.findLastAssistantTurn(turns);
					if (lastAssistant) {
						for (const result of toolResults) {
							lastAssistant.contentBlocks.push(result);
						}
						if (record.timestamp) {
							lastAssistant.endTimestamp = this.formatTimestamp(record.timestamp);
						}
					}
				}

				const userBlocks = this.extractUserContent(record);
				if (userBlocks.length > 0) {
					flushAssistant();
					const ts = this.formatTimestamp(record.timestamp);
					turns.push({
						index: turns.length,
						role: 'user',
						timestamp: ts,
						endTimestamp: ts,
						contentBlocks: userBlocks,
					});
				}
			}
		}

		flushAssistant();
		return turns;
	}

	/** Detect interruption messages in user records. */
	private isInterruptionMessage(record: ClaudeRecord): boolean {
		const content = record.message?.content;
		if (typeof content === 'string') {
			return content.startsWith('[Request interrupted by user');
		}
		if (Array.isArray(content)) {
			for (const block of content as ClaudeContentBlock[]) {
				if (block.type === 'text' && block.text?.startsWith('[Request interrupted by user')) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Parse sub-agent progress records into a SubAgentSession.
	 * Normalizes the nested agent_progress format into standard ClaudeRecords,
	 * deduplicates by uuid, and builds turns using the same merging logic.
	 */
	private buildSubAgentSession(
		agentRecords: ClaudeRecord[],
		parentBlock: ToolUseBlock,
	): SubAgentSession {
		// Normalize agent_progress records into standard ClaudeRecord shape
		const normalized: ClaudeRecord[] = [];
		let agentId = '';
		let prompt = '';

		for (const record of agentRecords) {
			const data = record.data;
			if (!data?.message) continue;

			if (data.agentId && !agentId) agentId = data.agentId;
			if (data.prompt && !prompt) prompt = data.prompt;

			const innerMsg = data.message;
			const innerType = innerMsg.type; // 'user' or 'assistant'
			if (!innerType) continue;

			normalized.push({
				type: innerType,
				uuid: innerMsg.uuid,
				timestamp: innerMsg.timestamp ?? record.timestamp,
				message: innerMsg.message ? {
					role: innerMsg.message.role,
					content: innerMsg.message.content,
					model: innerMsg.message.model,
					usage: innerMsg.message.usage,
				} : undefined,
			});
		}

		// Deduplicate by uuid (same as main parse)
		const byUuid = new Map<string, ClaudeRecord>();
		const ordered: ClaudeRecord[] = [];
		for (const record of normalized) {
			if (record.uuid) {
				if (byUuid.has(record.uuid)) {
					const idx = ordered.indexOf(byUuid.get(record.uuid)!);
					if (idx !== -1) ordered[idx] = record;
				} else {
					ordered.push(record);
				}
				byUuid.set(record.uuid, record);
			} else {
				ordered.push(record);
			}
		}

		// Save/restore pendingCommand state so sub-agent parsing doesn't interfere
		const savedPending = this.pendingCommand;
		this.pendingCommand = null;
		const turns = this.buildTurns(ordered);
		this.pendingCommand = savedPending;

		return {
			agentId,
			description: String(parentBlock.input['description'] || ''),
			subagentType: String(parentBlock.input['subagent_type'] || ''),
			prompt,
			turns,
		};
	}

	/** Parse <task-notification> XML from queue-operation or user records. */
	private static parseTaskNotification(
		content: string,
	): { taskId: string; toolUseId: string; result: string; summary: string } | null {
		const toolUseId = content.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/)?.[1]?.trim();
		if (!toolUseId) return null;
		const taskId = content.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]?.trim() ?? '';
		const summary = content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? '';
		const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim() ?? '';
		return { taskId, toolUseId, result, summary };
	}

	private parseAssistantBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>
	): ContentBlock[] {
		const msg = record.message;
		if (!msg) return [];

		const timestamp = record.timestamp;
		const blocks: ContentBlock[] = [];
		if (typeof msg.content === 'string') {
			if (msg.content.trim()) {
				blocks.push({ type: 'text', text: msg.content, timestamp });
			}
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content as ClaudeContentBlock[]) {
				const parsed = this.parseContentBlock(block, toolUseNames, timestamp);
				if (parsed) blocks.push(parsed);
			}
		}
		return blocks;
	}

	private extractToolResultBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>
	): ToolResultBlock[] {
		const msg = record.message;
		if (!msg) return [];

		const timestamp = record.timestamp;
		const results: ToolResultBlock[] = [];
		if (Array.isArray(msg.content)) {
			for (const block of msg.content as ClaudeContentBlock[]) {
				if (block.type === 'tool_result' && block.tool_use_id) {
					const resultContent = typeof block.content === 'string'
						? block.content
						: Array.isArray(block.content)
							? (block.content as ToolResultContent[])
								.map(c => c.text ?? c.content ?? '')
								.filter(s => s)
								.join('\n')
							: '';

					results.push({
						type: 'tool_result',
						toolUseId: block.tool_use_id,
						toolName: toolUseNames.get(block.tool_use_id),
						content: resultContent,
						isError: block.is_error || false,
						timestamp,
					});
				}
			}
		}
		return results;
	}

	/** Track commands whose stdout should be captured as ANSI blocks. */
	private pendingCommand: string | null = null;

	/** Commands whose <local-command-stdout> should be rendered as ANSI output. */
	private static readonly ANSI_COMMANDS = new Set(['/context']);

	/** Extract content from system records (slash commands like /rename, /compact). */
	private extractSystemContent(record: ClaudeRecord): ContentBlock[] {
		const content = record.content ?? '';
		const timestamp = record.timestamp;

		// Skip stdout/caveat/stderr follow-up records (they follow the command record)
		if (/^<local-command-stdout>/.test(content) || /^<local-command-caveat>/.test(content)
			|| /^<local-command-stderr>/.test(content)) {
			return [];
		}

		// Extract command name from <command-name>/foo</command-name>
		const cmdMatch = content.match(/<command-name>(\/\w+)<\/command-name>/);
		if (!cmdMatch) return [];

		const cmd = cmdMatch[1];
		// /exit is handled separately (consolidated into "*Session ended*")
		if (cmd === '/exit') return [];

		// Extract args if present
		const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
		const text = argsMatch ? `${cmd} ${argsMatch[1]}` : cmd;

		return [{ type: 'text', text, timestamp } as TextBlock];
	}

	/** Extract user content blocks from a record, handling string, text, and image blocks. */
	private extractUserContent(record: ClaudeRecord): ContentBlock[] {
		const content = record.message?.content;
		const timestamp = record.timestamp;
		if (typeof content === 'string') {
			// Consolidate /exit command sequences into a single subtle message
			// Anchored to ^ so tags embedded in user text (e.g. pasted JSON) don't match
			if (/^<command-name>\/exit<\/command-name>/.test(content)) {
				this.pendingCommand = null;
				return [{ type: 'text', text: '*Session ended*', timestamp } as TextBlock];
			}
			// Detect slash commands
			const cmdMatch = content.match(/^<command-name>(\/\w+)<\/command-name>/);
			if (cmdMatch) {
				const cmd = cmdMatch[1];
				// Commands that produce ANSI output
				if (ClaudeParser.ANSI_COMMANDS.has(cmd)) {
					this.pendingCommand = cmd;
					return [{ type: 'text', text: cmd, timestamp } as TextBlock];
				}
				// All other slash commands: extract args and message for readable display
				const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
				const msgMatch = content.match(/<command-message>([\s\S]*?)<\/command-message>/);
				const parts = [cmd];
				if (argsMatch?.[1]?.trim()) parts.push(argsMatch[1].trim());
				if (msgMatch?.[1]?.trim()) parts.push(msgMatch[1].trim());
				return [{ type: 'text', text: parts.join(' '), timestamp } as TextBlock];
			}
			// Capture ANSI output from local command stdout when a pending command is active
			if (/^<local-command-stdout>/.test(content) && this.pendingCommand) {
				const label = this.pendingCommand;
				this.pendingCommand = null;
				const stdout = content.replace(/<\/?local-command-stdout>/g, '');
				return [{ type: 'ansi', label, text: stdout, timestamp } as AnsiBlock];
			}
			// Skip local command output that follows /exit (e.g. "Goodbye!")
			if (/^<local-command-stdout>/.test(content)) {
				return [];
			}
			// Skip local command caveats and stderr (usually also filtered by isMeta)
			if (/^<local-command-caveat>/.test(content) || /^<local-command-stderr>/.test(content)) {
				return [];
			}
			// Skip task notification messages (system-injected, not user-typed)
			if (/^<task-notification>/.test(content)) {
				return [];
			}
			// Strip system/internal tags and image references
			let cleaned = content;
			cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
			cleaned = cleaned.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
			cleaned = cleaned.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');
			cleaned = cleaned.replace(/\[Image:\s*source:\s*.+?\]/gi, '');
			cleaned = cleaned.trim();
			if (!cleaned) {
				return [];
			}
			return [{ type: 'text', text: cleaned, timestamp } as TextBlock];
		}
		if (Array.isArray(content)) {
			const blocks: ContentBlock[] = [];
			for (const block of content as ClaudeContentBlock[]) {
				if (block.type === 'text' && block.text?.trim()) {
					blocks.push({ type: 'text', text: block.text, timestamp } as TextBlock);
				} else if (block.type === 'image' && block.source?.data) {
					blocks.push({
						type: 'image',
						mediaType: block.source.media_type ?? 'image/png',
						data: block.source.data,
						timestamp,
					} as ImageBlock);
				}
			}
			return blocks;
		}
		return [];
	}

	private findLastAssistantTurn(turns: Turn[]): Turn | null {
		for (let i = turns.length - 1; i >= 0; i--) {
			if (turns[i].role === 'assistant') return turns[i];
		}
		return null;
	}

	private parseContentBlock(
		block: ClaudeContentBlock,
		toolUseNames: Map<string, string>,
		timestamp?: string
	): ContentBlock | null {
		switch (block.type) {
			case 'text':
				if (block.text && block.text.trim()) {
					return { type: 'text', text: block.text, timestamp } as TextBlock;
				}
				return null;

			case 'thinking':
				if (block.thinking && block.thinking.trim()) {
					return { type: 'thinking', thinking: block.thinking, timestamp } as ThinkingBlock;
				}
				// Encrypted thinking (signature-only) — skip, nothing useful to display
				return null;

			case 'tool_use':
				if (block.id && block.name) {
					toolUseNames.set(block.id, block.name);
					return {
						type: 'tool_use',
						id: block.id,
						name: block.name,
						input: block.input || {},
						timestamp,
					} as ToolUseBlock;
				}
				return null;

			default:
				return null;
		}
	}
}

/**
 * Resolve sub-agent sessions by reading their JSONL files.
 * Both background and foreground agents have full JSONL files at
 * <sessionBase>/subagents/agent-<agentId>.jsonl. Background agents need this
 * because they don't stream agent_progress records. Foreground agents benefit
 * because agent_progress records omit assistant text blocks — only tool_use
 * and tool_result are streamed. Reading the JSONL file recovers the full
 * chain-of-thought text.
 */
export async function resolveSubAgentSessions(
	session: Session,
	readFile: (path: string) => Promise<string>,
): Promise<void> {
	const sessionBase = session.rawPath.replace(/\.jsonl$/, '');
	const parser = new ClaudeParser({ allowSidechain: true });

	for (const turn of session.turns) {
		for (const block of turn.contentBlocks) {
			if (block.type === 'tool_use'
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

function basename(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	const last = parts[parts.length - 1] || '';
	return last.replace(/\.jsonl$/, '');
}
