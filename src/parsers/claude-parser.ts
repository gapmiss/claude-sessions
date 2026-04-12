import { BaseParser } from './base-parser';
import {
	Session, Turn, ContentBlock, TextBlock,
	ToolUseBlock, ToolResultBlock, ImageBlock, AnsiBlock, CompactionBlock, SlashCommandBlock,
	BashCommandBlock, SessionStats, SubAgentSession, SystemEvent, ParseWarning,
	PermissionModeEvent, SkillListingEvent, HookSuccessEvent, AsyncHookResponseEvent, TaskReminderEvent,
} from '../types';
import { extractProjectName, projectFromCwd, dirname, basename } from '../utils/path-utils';
import {
	RT_USER, RT_ASSISTANT, RT_PROGRESS, RT_QUEUE_OPERATION, RT_FILE_HISTORY, RT_SUMMARY, RT_SYSTEM, RT_CUSTOM_TITLE,
	SKIP_RECORD_TYPES,
	BT_TEXT, BT_TOOL_USE, BT_TOOL_RESULT, BT_IMAGE,
	PROGRESS_AGENT,
	SUBAGENT_TOOL_NAMES, MODEL_SYNTHETIC, SUBTYPE_LOCAL_COMMAND,
	TAG_TASK_NOTIFICATION, TAG_COMMAND_MESSAGE_OPEN,
	RE_COMMAND_NAME, RE_COMMAND_ARGS,
	RE_EXIT_COMMAND, RE_SLASH_COMMAND,
	RE_LOCAL_STDOUT, RE_LOCAL_CAVEAT, RE_LOCAL_STDERR,
	RE_BASH_INPUT, RE_BASH_STDOUT, RE_BASH_STDERR,
	RE_SYSTEM_REMINDER, RE_COMMAND_MESSAGE_STRIP, RE_COMMAND_ARGS_STRIP,
	RE_IMAGE_REF, RE_LOCAL_STDOUT_TAGS,
	TEXT_SESSION_ENDED, TEXT_INTERRUPTION,
	ANSI_COMMANDS, ANSI_RE, RE_AGENT_ID,
} from '../constants';
import { parseTaskNotification } from './claude-subagent';
import { Logger } from '../utils/logger';
import {
	parseContentBlock, extractToolResultBlocks, isInterruptionMessage,
} from './claude-content';

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
	isVisibleInTranscriptOnly?: boolean;
	summary?: string;
	operation?: string;
	compactMetadata?: {
		trigger?: string;
		preTokens?: number;
	};
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
	error?: string;
	isApiErrorMessage?: boolean;
	// permission-mode records
	permissionMode?: string;
	// attachment records
	attachment?: Record<string, unknown>;
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

function hasAnsiCodes(text: string): boolean {
	return ANSI_RE.test(text);
}

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
			if (type === RT_USER || type === RT_ASSISTANT) {
				const msg = record['message'] as Record<string, unknown> | undefined;
				if (msg && ('role' in msg)) return true;
			}
			if (type === RT_FILE_HISTORY || record['sessionId']) return true;
		}
		return false;
	}

	parse(content: string, filePath: string): Session {
		// Reset parse error count for this file
		this.parseErrorCount = 0;
		const lines = this.splitLines(content);
		const records: ClaudeRecord[] = [];
		let sessionId = '';
		let cwd = '';
		let version = '';
		let branch = '';
		let model = '';
		let startTime = '';
		let customTitle = '';

		// Collect sub-agent progress records by parentToolUseID
		const agentProgressMap = new Map<string, ClaudeRecord[]>();

		// Token usage per message ID (keep max of each field across streaming duplicates)
		const usageByMsg = new Map<string, { inp: number; out: number; cr: number; cc: number }>();
		let anonymousUsageCounter = 0;

		// Track last API call's input tokens for context window size
		let lastCallInput = 0;
		let lastCallCacheRead = 0;
		let lastCallCacheWrite = 0;

		// Enriched tool results by sourceToolUseID
		const enrichedResults = new Map<string, Record<string, unknown>>();

		// Collect task-notification results for background agents (keyed by tool-use-id)
		const taskNotifications = new Map<string, { taskId: string; toolUseId: string; result: string; summary: string; durationMs?: number }>();

		// First pass: parse all records and extract metadata
		for (const line of lines) {
			const record = this.tryParseJson(line) as ClaudeRecord | null;
			if (!record) continue;

			// Capture agent_progress records for sub-agent rendering
			if (record.type === RT_PROGRESS && record.data?.type === PROGRESS_AGENT
				&& record.parentToolUseID) {
				const group = agentProgressMap.get(record.parentToolUseID) ?? [];
				group.push(record);
				agentProgressMap.set(record.parentToolUseID, group);
			}

			// Track max token usage per message ID (streaming produces duplicates)
			// U3: Use content fingerprint for anonymous records to avoid double-counting
			if (record.type === RT_ASSISTANT && record.message?.usage) {
				const msgId = (record.message as Record<string, unknown>)['id'] as string | undefined;
				let key: string;
				if (msgId) {
					key = msgId;
				} else if (record.uuid) {
					key = record.uuid;
				} else {
					// Generate content fingerprint for anonymous records to deduplicate streaming duplicates
					const contentSig = typeof record.message.content === 'string'
						? record.message.content.slice(0, 200)
						: Array.isArray(record.message.content)
							? record.message.content.map(b => `${b.type}:${(b.text ?? b.thinking ?? '').slice(0, 50)}`).join('|')
							: '';
					key = `__anon_${contentSig}_${anonymousUsageCounter++}`;
				}
				const u = record.message.usage;
				const prev = usageByMsg.get(key);
				usageByMsg.set(key, {
					inp: Math.max(prev?.inp ?? 0, u.input_tokens ?? 0),
					out: Math.max(prev?.out ?? 0, u.output_tokens ?? 0),
					cr: Math.max(prev?.cr ?? 0, u.cache_read_input_tokens ?? 0),
					cc: Math.max(prev?.cc ?? 0, u.cache_creation_input_tokens ?? 0),
				});

				// Track last API call for context window size
				lastCallInput = u.input_tokens ?? 0;
				lastCallCacheRead = u.cache_read_input_tokens ?? 0;
				lastCallCacheWrite = u.cache_creation_input_tokens ?? 0;
			}

			// Capture enriched toolUseResult from user entries
			if (record.type === RT_USER && record.toolUseResult) {
				if (record.sourceToolUseID) {
					enrichedResults.set(record.sourceToolUseID, record.toolUseResult);
				} else if (Array.isArray(record.message?.content)) {
					for (const item of record.message.content) {
						if (item.type === BT_TOOL_RESULT && item.tool_use_id) {
							enrichedResults.set(item.tool_use_id, record.toolUseResult);
						}
					}
				}
			}

			// Capture task-notification results from queue-operation and user records
			// before they are skipped — these carry background agent completion data
			if (record.type === RT_QUEUE_OPERATION && record.content?.startsWith(TAG_TASK_NOTIFICATION)) {
				const tn = parseTaskNotification(record.content);
				if (tn) taskNotifications.set(tn.toolUseId, tn);
			}
			if (record.type === RT_USER && typeof record.message?.content === 'string'
				&& record.message.content.startsWith(TAG_TASK_NOTIFICATION)) {
				const tn = parseTaskNotification(record.message.content);
				if (tn) taskNotifications.set(tn.toolUseId, tn);
			}

			// Capture custom-title from /rename command (keep last value)
			if (record.type === RT_CUSTOM_TITLE) {
				const title = (record as unknown as { customTitle?: string }).customTitle;
				if (title) customTitle = title;
				continue;
			}

			if (SKIP_RECORD_TYPES.has(record.type)) continue;
			if (record.isSidechain && !this.allowSidechain) continue;
			// Keep isMeta user records — they may contain skill expansion prompts
		if (record.isMeta && record.type !== RT_USER) continue;
			if (record.type === RT_ASSISTANT && record.message?.model === MODEL_SYNTHETIC) continue;

			// Let summary records through for compaction boundary rendering
			if (record.type === RT_SUMMARY) {
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

		// U2: Deduplicate by uuid — keep the most complete (last) record
		// Use Map<uuid, index> for O(1) lookups instead of O(n) indexOf
		const uuidToIndex = new Map<string, number>();
		const ordered: ClaudeRecord[] = [];
		for (const record of records) {
			if (record.uuid) {
				const existingIdx = uuidToIndex.get(record.uuid);
				if (existingIdx !== undefined) {
					// Replace with newer version (more content) - O(1) lookup
					ordered[existingIdx] = record;
				} else {
					uuidToIndex.set(record.uuid, ordered.length);
					ordered.push(record);
				}
			} else {
				ordered.push(record);
			}
		}

		// Track unknown record types that passed through filters but weren't handled
		const unknownRecordTypes = new Map<string, { count: number; sample?: Record<string, unknown> }>();
		const unknownBlockTypes = new Map<string, { count: number; sample?: Record<string, unknown> }>();

		// Second pass: build turns from deduplicated records
		const { turns, systemEvents } = this.buildTurns(ordered, unknownRecordTypes, unknownBlockTypes);

		// Attach sub-agent sessions to their corresponding Agent tool_use blocks
		if (agentProgressMap.size > 0) {
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === BT_TOOL_USE
						&& SUBAGENT_TOOL_NAMES.has(block.name)
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
					if (block.type === BT_TOOL_USE
						&& SUBAGENT_TOOL_NAMES.has(block.name)
						&& !block.subAgentSession
						&& taskNotifications.has(block.id)) {
						const tn = taskNotifications.get(block.id)!;
						block.subAgentSession = {
							agentId: tn.taskId,
							description: typeof block.input['description'] === 'string' ? block.input['description'] : '',
							subagentType: typeof block.input['subagent_type'] === 'string' ? block.input['subagent_type'] : '',
							prompt: typeof block.input['prompt'] === 'string' ? block.input['prompt'] : '',
							turns: [],
							isBackground: true,
							durationMs: tn.durationMs,
						};
					}
					// Replace the "Async agent launched successfully" tool_result
					// with the actual notification result
					if (block.type === BT_TOOL_RESULT && taskNotifications.has(block.toolUseId)) {
						block.content = taskNotifications.get(block.toolUseId)!.result;
					}
				}
			}
		}

		// Ensure all Agent/Task blocks have a subAgentSession for consistent
		// rendering (PROMPT/OUTPUT layout vs raw JSON INPUT/RESULT).
		// Covers: background agents (run_in_background), foreground agents
		// without agent_progress records, and any other gaps.
		for (const turn of turns) {
			for (const block of turn.contentBlocks) {
				if (block.type === BT_TOOL_USE
					&& SUBAGENT_TOOL_NAMES.has(block.name)
					&& !block.subAgentSession) {
					const isBg = block.input['run_in_background'] === true;
					block.subAgentSession = {
						agentId: '',
						description: typeof block.input['description'] === 'string' ? block.input['description'] : '',
						subagentType: typeof block.input['subagent_type'] === 'string' ? block.input['subagent_type'] : '',
						prompt: typeof block.input['prompt'] === 'string' ? block.input['prompt'] : '',
						turns: [],
						isBackground: isBg || undefined,
					};
				}
			}
		}

		// Extract agentId from tool_result text for Agent blocks that lack one.
		// Foreground agents include "agentId: <id>" in one of the result text blocks.
		{
			// Build a map of tool_use_id → ToolUseBlock for agent blocks missing agentId
			const agentBlocksById = new Map<string, ToolUseBlock>();
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === BT_TOOL_USE
						&& SUBAGENT_TOOL_NAMES.has(block.name)
						&& block.subAgentSession
						&& !block.subAgentSession.agentId) {
						agentBlocksById.set(block.id, block);
					}
				}
			}
			if (agentBlocksById.size > 0) {
				for (const turn of turns) {
					for (const block of turn.contentBlocks) {
						if (block.type === BT_TOOL_RESULT && agentBlocksById.has(block.toolUseId)) {
							const match = block.content?.match(RE_AGENT_ID);
							if (match) {
								agentBlocksById.get(block.toolUseId)!.subAgentSession!.agentId = match[1];
								agentBlocksById.delete(block.toolUseId);
							}
						}
					}
				}
			}
		}

		// Attach enriched results and mark orphaned tool_use blocks
		const resultIds = new Set<string>();
		for (const turn of turns) {
			for (const block of turn.contentBlocks) {
				if (block.type === BT_TOOL_RESULT) {
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
				if (block.type === BT_TOOL_USE && !resultIds.has(block.id)) {
					if (turn === lastAssistantTurn) {
						block.isPending = true;
					} else {
						block.isOrphaned = true;
					}
				}
			}
		}

		const project = cwd ? projectFromCwd(cwd) : extractProjectName(dirname(filePath));

		// Compute stats
		const toolUseCounts: Record<string, number> = {};
		let userTurns = 0;
		let assistantTurns = 0;
		for (const turn of turns) {
			if (turn.role === 'user') userTurns++;
			else assistantTurns++;
			for (const block of turn.contentBlocks) {
				if (block.type === BT_TOOL_USE) {
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
				const d = new Date(last).getTime() - new Date(first).getTime();
				if (!isNaN(d) && d >= 0) durationMs = d;
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

		const contextWindowTokens = lastCallInput + lastCallCacheRead + lastCallCacheWrite;
		const costUSD = estimateCost(
			model, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens,
		);

		const stats: SessionStats = {
			userTurns,
			assistantTurns,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: totalCacheReadTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			totalTokens: totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheCreationTokens,
			contextWindowTokens,
			costUSD,
			toolUseCounts,
			durationMs,
		};

		// H4: Build warnings array for UI surfacing
		const warnings: ParseWarning[] = [];
		if (unknownRecordTypes.size > 0) {
			for (const [type, { count }] of unknownRecordTypes) {
				Logger.warn(`Skipped unknown record type "${type}" (${count}x)`);
				warnings.push({
					type: 'unknown_record_type',
					message: `Unknown record type "${type}" — plugin may need update`,
					count,
				});
			}
		}
		if (unknownBlockTypes.size > 0) {
			for (const [type, { count }] of unknownBlockTypes) {
				Logger.warn(`Skipped unknown block type "${type}" (${count}x)`);
				warnings.push({
					type: 'unknown_block_type',
					message: `Unknown block type "${type}" — plugin may need update`,
					count,
				});
			}
		}
		// M2: Surface parse error count
		if (this.parseErrorCount > 0) {
			warnings.push({
				type: 'parse_errors',
				message: `${this.parseErrorCount} JSONL line(s) failed to parse`,
				count: this.parseErrorCount,
			});
		}

		return {
			metadata: {
				id: sessionId || basename(filePath).replace(/\.jsonl$/, ''),
				format: 'claude',
				project,
				cwd,
				branch: branch || undefined,
				model: model || undefined,
				version: version || undefined,
				startTime: this.formatTimestamp(startTime),
				totalTurns: turns.length,
				customTitle: customTitle || undefined,
			},
			stats,
			turns,
			systemEvents,
			rawPath: filePath,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	/**
	 * Build turns by merging consecutive same-role records.
	 * Claude streams assistant responses as multiple records (thinking, text, tool_use),
	 * each with its own uuid. These should form a single assistant turn.
	 * User records containing only tool_result blocks should have those results
	 * attached to the preceding assistant turn (not become separate user turns).
	 */
	/**
	 * Build Turn[] from ordered, deduplicated records.
	 *
	 * STRUCTURAL ASSUMPTIONS (update if Claude Code changes its JSONL format):
	 * 1. Consecutive assistant records merge into one Turn. If a non-assistant
	 *    record (e.g. progress) interleaves, the turn is split.
	 * 2. User records with only tool_result blocks attach to the preceding
	 *    assistant turn. If results arrive before their tool_use, attachment fails.
	 * 3. XML tags (<task-notification>, <command-name>, etc.) are parsed via regex.
	 *    Schema changes to the XML structure will break extraction silently.
	 */
	private buildTurns(
		ordered: ClaudeRecord[],
		unknownRecordTypes?: Map<string, { count: number; sample?: Record<string, unknown> }>,
		unknownBlockTypes?: Map<string, { count: number; sample?: Record<string, unknown> }>,
	): { turns: Turn[]; systemEvents: SystemEvent[] } {
		const turns: Turn[] = [];
		const systemEvents: SystemEvent[] = [];
		const toolUseNames = new Map<string, string>();
		// Map record uuid → [{toolUseId, toolName}] for resolving async_hook_response parentUuid
		const uuidToToolResults = new Map<string, Array<{ toolUseId: string; toolName: string }>>();
		// Map uuid → parentUuid for walking up the parent chain
		const uuidToParent = new Map<string, string>();
		let currentAssistantTurn: Turn | null = null;
		let pendingCompactMeta: { trigger?: string; preTokens?: number } | null = null;

		const flushAssistant = () => {
			if (currentAssistantTurn && currentAssistantTurn.contentBlocks.length > 0) {
				currentAssistantTurn.index = turns.length;
				turns.push(currentAssistantTurn);
			}
			currentAssistantTurn = null;
		};

		for (const record of ordered) {
			// Track parent chain for async_hook_response resolution
			if (record.uuid && record.parentUuid) {
				uuidToParent.set(record.uuid, record.parentUuid);
			}

			// Summary records → compaction boundary
			if (record.type === RT_SUMMARY) {
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

			// System records
			if (record.type === RT_SYSTEM) {
				// compact_boundary → stash metadata for the isCompactSummary user record that follows
				if (record.subtype === 'compact_boundary' && record.compactMetadata) {
					pendingCompactMeta = record.compactMetadata;
				}
				if (record.subtype === SUBTYPE_LOCAL_COMMAND && record.content) {
					const blocks = this.extractSystemContent(record);
					if (blocks.length > 0) {
						// Merge stdout output with preceding slash command turn
						if (this._pendingCommandResult) {
							this._pendingCommandResult = false;
							const lastTurn = turns[turns.length - 1];
							if (lastTurn?.role === 'user') {
								for (const b of blocks) lastTurn.contentBlocks.push(b);
								if (record.timestamp) lastTurn.endTimestamp = this.formatTimestamp(record.timestamp);
							}
						} else {
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
					}
				}
				// Other system records (hook results, metadata) are non-content — skip
				continue;
			}

			if (record.type === RT_ASSISTANT) {
				const blocks = this.parseAssistantBlocks(record, toolUseNames, unknownBlockTypes);
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
				if (record.message?.model && record.message.model !== MODEL_SYNTHETIC
					&& !currentAssistantTurn.model) {
					currentAssistantTurn.model = record.message.model;
				}
				if (record.message?.stop_reason) {
					currentAssistantTurn.stopReason = record.message.stop_reason;
				}
				if (record.isApiErrorMessage && record.error) {
					currentAssistantTurn.isApiError = true;
					currentAssistantTurn.errorType = record.error;
				}
				for (const b of blocks) {
					currentAssistantTurn.contentBlocks.push(b);
				}
			} else if (record.type === RT_USER) {
				// Handle skill expansion (isMeta follow-up to a slash command)
				if (record.isMeta && this._pendingSlashCommand) {
					const expText = this.extractSkillExpansionText(record);
					if (expText) {
						const lastTurn = turns[turns.length - 1];
						if (lastTurn?.role === 'user') {
							lastTurn.contentBlocks.push({
								type: 'slash_command',
								commandName: this._pendingSlashCommand,
								text: expText,
								timestamp: record.timestamp,
							} as SlashCommandBlock);
						}
						this._pendingSlashCommand = null;
						continue;
					}
				}
				// Skip other isMeta user records (local command caveats, etc.)
				if (record.isMeta) continue;

				// Clear stale pending slash command — the expansion record (if any)
				// always immediately follows the command record
				this._pendingSlashCommand = null;

				// isCompactSummary user entries → compaction boundary with summary content
				if (record.isCompactSummary) {
					flushAssistant();
					const ts = this.formatTimestamp(record.timestamp);
					// Extract the continuation summary from message content
					let summary: string | undefined;
					const mc = record.message?.content;
					if (typeof mc === 'string' && mc.trim()) {
						summary = mc;
					} else if (Array.isArray(mc)) {
						const texts: string[] = [];
						for (const b of mc) {
							if (b.type === BT_TEXT && b.text?.trim()) texts.push(b.text);
						}
						if (texts.length > 0) summary = texts.join('\n\n');
					}
					const block: CompactionBlock = {
						type: 'compaction',
						summary,
						timestamp: record.timestamp,
					};
					if (pendingCompactMeta?.preTokens) {
						block.preTokens = pendingCompactMeta.preTokens;
					}
					pendingCompactMeta = null;
					turns.push({
						index: turns.length,
						role: 'assistant',
						timestamp: ts,
						endTimestamp: ts,
						contentBlocks: [block],
					});
					continue;
				}

				// Skip task notification messages (system-injected, not user-typed)
				if (typeof record.message?.content === 'string'
					&& record.message.content.startsWith(TAG_TASK_NOTIFICATION)) {
					continue;
				}

				// Interruption messages attach to assistant turn, not separate user turn
				if (isInterruptionMessage(record.message)) {
					if (currentAssistantTurn) {
						currentAssistantTurn.contentBlocks.push({
							type: 'text',
							text: TEXT_INTERRUPTION,
							timestamp: record.timestamp,
						} as TextBlock);
						if (record.timestamp) {
							currentAssistantTurn.endTimestamp = this.formatTimestamp(record.timestamp);
						}
					}
					continue;
				}

				const toolResults = this.extractToolResultBlocks(record, toolUseNames);

				// Track uuid → tool_use_id for async_hook_response resolution
				if (toolResults.length > 0 && record.uuid) {
					const entries = toolResults.map(r => ({
						toolUseId: r.toolUseId,
						toolName: r.toolName ?? '',
					}));
					uuidToToolResults.set(record.uuid, entries);
				}

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

				// Flush orphaned bash-input if current record is not bash-stdout
				if (this._pendingBashCommand) {
					const rc = typeof record.message?.content === 'string' ? record.message.content : '';
					if (!RE_BASH_STDOUT.test(rc)) {
						flushAssistant();
						const ts = this.formatTimestamp(this._pendingBashCommand.timestamp);
						turns.push({
							index: turns.length,
							role: 'user',
							timestamp: ts,
							endTimestamp: ts,
							contentBlocks: [{
								type: 'bash_command',
								command: this._pendingBashCommand.command,
								stdout: '',
								stderr: '',
								timestamp: this._pendingBashCommand.timestamp,
							} as BashCommandBlock],
						});
						this._pendingBashCommand = null;
					}
				}

				const userBlocks = this.extractUserContent(record);
				if (userBlocks.length > 0) {
					// Merge command output with preceding slash command turn
					if (this._pendingCommandResult) {
						this._pendingCommandResult = false;
						const lastTurn = turns[turns.length - 1];
						if (lastTurn?.role === 'user') {
							for (const b of userBlocks) lastTurn.contentBlocks.push(b);
							if (record.timestamp) lastTurn.endTimestamp = this.formatTimestamp(record.timestamp);
						}
					} else {
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
			} else if (record.type === 'permission-mode') {
				// Permission mode system event
				systemEvents.push({
					type: 'permission-mode',
					uuid: record.uuid || '',
					timestamp: this.formatTimestamp(record.timestamp) || '',
					permissionMode: record.permissionMode || 'unknown',
				} as PermissionModeEvent);
			} else if (record.type === 'attachment' && record.attachment) {
				// Attachment system events (hooks, skills, tasks)
				const att = record.attachment;
				const str = (v: unknown): string => typeof v === 'string' ? v : '';
				const baseEvent = {
					uuid: record.uuid || '',
					timestamp: this.formatTimestamp(record.timestamp) || '',
					parentUuid: record.parentUuid,
				};

				if (att.type === 'skill_listing') {
					systemEvents.push({
						...baseEvent,
						type: 'skill_listing',
						content: str(att.content),
						skillCount: typeof att.skillCount === 'number' ? att.skillCount : 0,
						isInitial: Boolean(att.isInitial),
					} as SkillListingEvent);
				} else if (att.type === 'hook_success') {
					systemEvents.push({
						...baseEvent,
						type: 'hook_success',
						hookName: str(att.hookName),
						hookEvent: str(att.hookEvent),
						command: str(att.command),
						durationMs: typeof att.durationMs === 'number' ? att.durationMs : 0,
						stdout: str(att.stdout),
						stderr: str(att.stderr),
						exitCode: typeof att.exitCode === 'number' ? att.exitCode : 0,
						toolUseId: typeof att.toolUseID === 'string' ? att.toolUseID : undefined,
					} as HookSuccessEvent);
				} else if (att.type === 'async_hook_response') {
					// Resolve toolUseId via parentUuid → tool_result mapping
					// Walk up the parent chain to find a record with tool_results
					let resolvedToolUseId: string | undefined;
					let currentUuid = record.parentUuid;
					const maxDepth = 20; // L3: Increased from 10 to handle deeply nested agent hierarchies
					for (let depth = 0; depth < maxDepth && currentUuid; depth++) {
						const parentEntries = uuidToToolResults.get(currentUuid);
						if (parentEntries && parentEntries.length > 0) {
							// Extract tool name from hookName (e.g., "PermissionRequest:Bash" → "Bash")
							const hookToolName = str(att.hookName).split(':')[1] ?? '';
							const match = parentEntries.find(e => e.toolName === hookToolName);
							resolvedToolUseId = match?.toolUseId ?? parentEntries[0].toolUseId;
							break;
						}
						// Move up to grandparent
						currentUuid = uuidToParent.get(currentUuid);
					}
					systemEvents.push({
						...baseEvent,
						type: 'async_hook_response',
						hookName: str(att.hookName),
						hookEvent: str(att.hookEvent),
						processId: str(att.processId),
						stdout: str(att.stdout),
						stderr: str(att.stderr),
						exitCode: typeof att.exitCode === 'number' ? att.exitCode : 0,
						toolUseId: resolvedToolUseId,
					} as AsyncHookResponseEvent);
				} else if (att.type === 'task_reminder') {
					systemEvents.push({
						...baseEvent,
						type: 'task_reminder',
						content: Array.isArray(att.content) ? att.content : [],
						itemCount: typeof att.itemCount === 'number' ? att.itemCount : 0,
					} as TaskReminderEvent);
				}
				// Unknown attachment subtypes are silently ignored
			} else if (unknownRecordTypes) {
				const existing = unknownRecordTypes.get(record.type);
				if (existing) {
					existing.count++;
				} else {
					// Capture a compact sample: top-level keys + message shape
					const sample: Record<string, unknown> = { type: record.type };
					if (record.message) {
						const msg = record.message;
						sample['message.role'] = msg.role;
						if (typeof msg.content === 'string') sample['message.content'] = msg.content.slice(0, 200);
						else if (Array.isArray(msg.content)) sample['message.content'] = msg.content.map((b) => b.type);
					}
					sample['keys'] = Object.keys(record).filter(k => k !== 'type');
					unknownRecordTypes.set(record.type, { count: 1, sample });
				}
			}
		}

		flushAssistant();
		return { turns, systemEvents };
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

		// Deduplicate by uuid (same as main parse) - O(1) lookups
		const uuidToIndex = new Map<string, number>();
		const ordered: ClaudeRecord[] = [];
		for (const record of normalized) {
			if (record.uuid) {
				const existingIdx = uuidToIndex.get(record.uuid);
				if (existingIdx !== undefined) {
					ordered[existingIdx] = record;
				} else {
					uuidToIndex.set(record.uuid, ordered.length);
					ordered.push(record);
				}
			} else {
				ordered.push(record);
			}
		}

		// Save/restore all pending state so sub-agent parsing doesn't corrupt the parent
		const savedPending = this.pendingCommand;
		const savedSlash = this._pendingSlashCommand;
		const savedBash = this._pendingBashCommand;
		const savedResult = this._pendingCommandResult;
		this.pendingCommand = null;
		this._pendingSlashCommand = null;
		this._pendingBashCommand = null;
		this._pendingCommandResult = false;
		const { turns } = this.buildTurns(ordered);
		this.pendingCommand = savedPending;
		this._pendingSlashCommand = savedSlash;
		this._pendingBashCommand = savedBash;
		this._pendingCommandResult = savedResult;

		return {
			agentId,
			description: typeof parentBlock.input['description'] === 'string' ? parentBlock.input['description'] : '',
			subagentType: typeof parentBlock.input['subagent_type'] === 'string' ? parentBlock.input['subagent_type'] : '',
			prompt,
			turns,
		};
	}

	private parseAssistantBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>,
		unknownBlockTypes?: Map<string, { count: number; sample?: Record<string, unknown> }>,
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
			for (const block of msg.content) {
				const parsed = parseContentBlock(block, toolUseNames, timestamp, unknownBlockTypes);
				if (parsed) blocks.push(parsed);
			}
		}
		return blocks;
	}

	private extractToolResultBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>
	): ToolResultBlock[] {
		return extractToolResultBlocks(record.message, toolUseNames, record.timestamp);
	}

	/** Track commands whose stdout should be captured. */
	private pendingCommand: string | null = null;
	/** When true, next user blocks should merge into the preceding slash command turn. */
	private _pendingCommandResult = false;
	/** Track slash command name so the following isMeta skill expansion can be captured. */
	private _pendingSlashCommand: string | null = null;
	/** Track pending bash-input awaiting bash-stdout/stderr. */
	private _pendingBashCommand: { command: string; timestamp?: string } | null = null;

	/** Extract content from system records (slash commands like /rename, /compact). */
	private extractSystemContent(record: ClaudeRecord): ContentBlock[] {
		const content = record.content ?? '';
		const timestamp = record.timestamp;

		// Skip caveat/stderr follow-up records
		if (RE_LOCAL_CAVEAT.test(content) || RE_LOCAL_STDERR.test(content)) {
			return [];
		}

		// Capture stdout from system records (follows a command record)
		if (RE_LOCAL_STDOUT.test(content)) {
			if (this.pendingCommand) {
				const label = this.pendingCommand;
				this.pendingCommand = null;
				const stdout = content.replace(RE_LOCAL_STDOUT_TAGS, '');
				if (ANSI_COMMANDS.has(label) || hasAnsiCodes(stdout)) {
					this._pendingCommandResult = true;
					return [{ type: 'ansi', label, text: stdout, timestamp } as AnsiBlock];
				}
				if (stdout.trim()) {
					this._pendingCommandResult = true;
					return [{ type: 'text', text: stdout.trim(), timestamp } as TextBlock];
				}
			}
			return [];
		}

		// Extract command name from <command-name>/foo</command-name>
		const cmdMatch = content.match(RE_COMMAND_NAME);
		if (!cmdMatch) return [];

		const cmd = cmdMatch[1];
		// /exit is handled separately (consolidated into session ended message)
		if (cmd === '/exit') return [];

		// Track pending command so stdout follow-up can be captured
		this.pendingCommand = cmd;

		// Extract args if present
		const argsMatch = content.match(RE_COMMAND_ARGS);
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
			if (RE_EXIT_COMMAND.test(content)) {
				this.pendingCommand = null;
				return [{ type: 'text', text: TEXT_SESSION_ENDED, timestamp } as TextBlock];
			}
			// Detect slash commands
			const cmdMatch = content.match(RE_SLASH_COMMAND);
			if (cmdMatch) {
				const cmd = cmdMatch[1];
				this.pendingCommand = cmd;
				// Only expect a skill expansion (isMeta follow-up) for skill commands,
				// identified by the presence of <command-message> tag. Built-in commands
				// like /compact, /context don't produce isMeta expansion records.
				if (content.includes(TAG_COMMAND_MESSAGE_OPEN)) {
					this._pendingSlashCommand = cmd;
				}
				// User-friendly display name: /wrap:wrap → /wrap
				const displayCmd = cmd.includes(':') ? cmd.split(':')[0] : cmd;
				// Commands that produce ANSI output
				if (ANSI_COMMANDS.has(cmd) || ANSI_COMMANDS.has(displayCmd)) {
					return [{ type: 'text', text: displayCmd, timestamp } as TextBlock];
				}
				// All other slash commands: extract args for readable display
				// Skip <command-message> — it just repeats the command name
				const argsMatch = content.match(RE_COMMAND_ARGS);
				const parts = [displayCmd];
				if (argsMatch?.[1]?.trim()) parts.push(argsMatch[1].trim());
				return [{ type: 'text', text: parts.join(' '), timestamp } as TextBlock];
			}
			// Capture output from local command stdout when a pending command is active
			if (RE_LOCAL_STDOUT.test(content) && this.pendingCommand) {
				const label = this.pendingCommand;
				this.pendingCommand = null;
				const stdout = content.replace(RE_LOCAL_STDOUT_TAGS, '');
				if (ANSI_COMMANDS.has(label) || hasAnsiCodes(stdout)) {
					this._pendingCommandResult = true;
					return [{ type: 'ansi', label, text: stdout, timestamp } as AnsiBlock];
				}
				// Non-ANSI command result (e.g. /export) → merge with command turn
				if (stdout.trim()) {
					this._pendingCommandResult = true;
					return [{ type: 'text', text: stdout.trim(), timestamp } as TextBlock];
				}
				return [];
			}
			// Skip local command output that follows /exit (e.g. "Goodbye!")
			if (RE_LOCAL_STDOUT.test(content)) {
				return [];
			}
			// Skip local command caveats and stderr (usually also filtered by isMeta)
			if (RE_LOCAL_CAVEAT.test(content) || RE_LOCAL_STDERR.test(content)) {
				return [];
			}
			// Detect <bash-input> — user-typed bash command; stash and wait for stdout
			const bashInputMatch = content.match(RE_BASH_INPUT);
			if (bashInputMatch) {
				this._pendingBashCommand = { command: bashInputMatch[1], timestamp };
				return [];
			}
			// Detect <bash-stdout> — output from user-typed bash command
			const bashStdoutMatch = content.match(RE_BASH_STDOUT);
			if (bashStdoutMatch != null) {
				const stdout = bashStdoutMatch[1] ?? '';
				const stderrMatch = content.match(RE_BASH_STDERR);
				const stderr = stderrMatch?.[1] ?? '';
				if (this._pendingBashCommand) {
					const block: BashCommandBlock = {
						type: 'bash_command',
						command: this._pendingBashCommand.command,
						stdout,
						stderr,
						timestamp: this._pendingBashCommand.timestamp,
					};
					this._pendingBashCommand = null;
					return [block];
				}
				return [];
			}
			// Skip task notification messages (system-injected, not user-typed)
			if (content.startsWith(TAG_TASK_NOTIFICATION)) {
				return [];
			}
			// Strip system/internal tags and image references
			let cleaned = content;
			cleaned = cleaned.replace(RE_SYSTEM_REMINDER, '');
			cleaned = cleaned.replace(RE_COMMAND_MESSAGE_STRIP, '');
			cleaned = cleaned.replace(RE_COMMAND_ARGS_STRIP, '');
			cleaned = cleaned.replace(RE_IMAGE_REF, '');
			cleaned = cleaned.trim();
			if (!cleaned) {
				return [];
			}
			return [{ type: 'text', text: cleaned, timestamp } as TextBlock];
		}
		if (Array.isArray(content)) {
			const blocks: ContentBlock[] = [];
			for (const block of content) {
				if (block.type === BT_TEXT && block.text?.trim()) {
					blocks.push({ type: 'text', text: block.text, timestamp } as TextBlock);
				} else if (block.type === BT_IMAGE && block.source?.data) {
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

	/** Extract text content from an isMeta user record (skill expansion prompt). */
	private extractSkillExpansionText(record: ClaudeRecord): string | null {
		const content = record.message?.content;
		// Caveat records are not skill expansions — skip them
		if (typeof content === 'string' && RE_LOCAL_CAVEAT.test(content)) return null;
		if (Array.isArray(content)) {
			const texts: string[] = [];
			for (const block of content) {
				if (block.type === BT_TEXT && block.text?.trim()) {
					// Skip caveat blocks
					if (RE_LOCAL_CAVEAT.test(block.text)) continue;
					// Strip system-reminder tags injected by Claude Code
					const cleaned = block.text.replace(RE_SYSTEM_REMINDER, '').trim();
					if (cleaned) texts.push(cleaned);
				}
			}
			return texts.length > 0 ? texts.join('\n\n') : null;
		}
		if (typeof content === 'string') {
			const cleaned = content.replace(RE_SYSTEM_REMINDER, '').trim();
			return cleaned || null;
		}
		return null;
	}

	private findLastAssistantTurn(turns: Turn[]): Turn | null {
		for (let i = turns.length - 1; i >= 0; i--) {
			if (turns[i].role === 'assistant') return turns[i];
		}
		return null;
	}

}

/** Per-million-token pricing by model family. */
interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
	opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	sonnet: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
	haiku: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

function getPricing(model: string): ModelPricing {
	const m = model.toLowerCase();
	if (m.includes('opus')) return MODEL_PRICING.opus;
	if (m.includes('haiku')) return MODEL_PRICING.haiku;
	return MODEL_PRICING.sonnet; // default
}

function estimateCost(
	model: string, input: number, output: number, cacheRead: number, cacheWrite: number,
): number {
	const p = getPricing(model);
	return (
		(input / 1_000_000) * p.input +
		(output / 1_000_000) * p.output +
		(cacheRead / 1_000_000) * p.cacheRead +
		(cacheWrite / 1_000_000) * p.cacheWrite
	);
}
