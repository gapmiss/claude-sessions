import { BaseParser } from './base-parser';
import {
	Session, Turn, ContentBlock, TextBlock,
	ToolUseBlock, ToolResultBlock, ImageBlock, AnsiBlock, CompactionBlock, SlashCommandBlock,
	HookEvent, SessionStats, SubAgentSession,
} from '../types';
import { extractProjectName, projectFromCwd, dirname } from '../utils/path-utils';
import {
	RT_USER, RT_ASSISTANT, RT_PROGRESS, RT_QUEUE_OPERATION, RT_FILE_HISTORY, RT_SUMMARY, RT_SYSTEM,
	SKIP_RECORD_TYPES,
	BT_TEXT, BT_TOOL_USE, BT_TOOL_RESULT, BT_IMAGE,
	PROGRESS_HOOK, PROGRESS_AGENT,
	SUBAGENT_TOOL_NAMES, MODEL_SYNTHETIC, OP_ENQUEUE, SUBTYPE_LOCAL_COMMAND,
	TAG_TASK_NOTIFICATION, TAG_COMMAND_MESSAGE_OPEN,
	RE_COMMAND_NAME, RE_COMMAND_ARGS,
	RE_EXIT_COMMAND, RE_SLASH_COMMAND,
	RE_LOCAL_STDOUT, RE_LOCAL_CAVEAT, RE_LOCAL_STDERR,
	RE_SYSTEM_REMINDER, RE_COMMAND_MESSAGE_STRIP, RE_COMMAND_ARGS_STRIP,
	RE_IMAGE_REF, RE_LOCAL_STDOUT_TAGS,
	TEXT_SESSION_ENDED, TEXT_INTERRUPTION,
	ANSI_COMMANDS,
} from '../constants';
import { parseTaskNotification } from './claude-subagent';
import {
	parseContentBlock, extractToolResultBlocks, isInterruptionMessage,
	basename,
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
	error?: string;
	isApiErrorMessage?: boolean;
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


const LOG_PREFIX = '[claude-sessions]';

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
		let anonymousUsageCounter = 0;

		// Track last API call's input tokens for context window size
		let lastCallInput = 0;
		let lastCallCacheRead = 0;
		let lastCallCacheWrite = 0;

		// Enriched tool results by sourceToolUseID
		const enrichedResults = new Map<string, Record<string, unknown>>();

		// Collect task-notification results for background agents (keyed by tool-use-id)
		const taskNotifications = new Map<string, { taskId: string; toolUseId: string; result: string; summary: string }>();

		// First pass: parse all records and extract metadata
		for (const line of lines) {
			const record = this.tryParseJson(line) as ClaudeRecord | null;
			if (!record) continue;

			// Capture hook_progress before skipping progress records
			if (record.type === RT_PROGRESS && record.data?.type === PROGRESS_HOOK
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
			if (record.type === RT_PROGRESS && record.data?.type === PROGRESS_AGENT
				&& record.parentToolUseID) {
				const group = agentProgressMap.get(record.parentToolUseID) ?? [];
				group.push(record);
				agentProgressMap.set(record.parentToolUseID, group);
			}

			// Track max token usage per message ID (streaming produces duplicates)
			if (record.type === RT_ASSISTANT && record.message?.usage) {
				const msgId = (record.message as Record<string, unknown>)['id'] as string | undefined;
				// Use uuid as fallback key when message.id is absent to avoid losing token data
				const key = msgId ?? record.uuid ?? `__anon_${anonymousUsageCounter++}`;
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

			if (record.type === RT_QUEUE_OPERATION && record.operation === OP_ENQUEUE && record.content) {
				// Enqueue records carry user messages — let them through
			} else if (SKIP_RECORD_TYPES.has(record.type)) continue;
			if (record.isSidechain && !this.allowSidechain) continue;
			// Keep isMeta user records — they may contain skill expansion prompts
		if (record.isMeta && record.type !== RT_USER) continue;
			if (record.type === RT_ASSISTANT && record.message?.model === MODEL_SYNTHETIC
				&& !record.isApiErrorMessage) continue;

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

		// Track unknown record types that passed through filters but weren't handled
		const unknownRecordTypes = new Map<string, number>();
		const unknownBlockTypes = new Map<string, number>();

		// Second pass: build turns from deduplicated records
		const turns = this.buildTurns(ordered, unknownRecordTypes, unknownBlockTypes);

		// Attach hook events to their corresponding tool_use blocks
		if (hookMap.size > 0) {
			for (const turn of turns) {
				for (const block of turn.contentBlocks) {
					if (block.type === BT_TOOL_USE && hookMap.has(block.id)) {
						block.hooks = hookMap.get(block.id);
					}
				}
			}
		}

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
							description: String(block.input['description'] || ''),
							subagentType: String(block.input['subagent_type'] || ''),
							prompt: String(block.input['prompt'] || ''),
							turns: [],
							isBackground: true,
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

		// Log diagnostics for unknown record/block types (signals format changes)
		if (unknownRecordTypes.size > 0) {
			const entries = [...unknownRecordTypes.entries()].map(([t, n]) => `${t}(${n})`).join(', ');
			console.warn(`${LOG_PREFIX} Skipped unknown record types: ${entries}`);
		}
		if (unknownBlockTypes.size > 0) {
			const entries = [...unknownBlockTypes.entries()].map(([t, n]) => `${t}(${n})`).join(', ');
			console.warn(`${LOG_PREFIX} Skipped unknown content block types: ${entries}`);
		}

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
		unknownRecordTypes?: Map<string, number>,
		unknownBlockTypes?: Map<string, number>,
	): Turn[] {
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
			if (record.type === RT_QUEUE_OPERATION && record.operation === OP_ENQUEUE && record.content) {
				// Skip system-injected task notifications
				if (record.content.startsWith(TAG_TASK_NOTIFICATION)) continue;
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

			// System records with local_command subtype (slash commands like /rename)
			if (record.type === RT_SYSTEM && record.subtype === SUBTYPE_LOCAL_COMMAND && record.content) {
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
			} else if (unknownRecordTypes) {
				unknownRecordTypes.set(record.type, (unknownRecordTypes.get(record.type) ?? 0) + 1);
			}
		}

		flushAssistant();
		return turns;
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

	private parseAssistantBlocks(
		record: ClaudeRecord,
		toolUseNames: Map<string, string>,
		unknownBlockTypes?: Map<string, number>,
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

	/** Extract content from system records (slash commands like /rename, /compact). */
	private extractSystemContent(record: ClaudeRecord): ContentBlock[] {
		const content = record.content ?? '';
		const timestamp = record.timestamp;

		// Skip stdout/caveat/stderr follow-up records (they follow the command record)
		if (RE_LOCAL_STDOUT.test(content) || RE_LOCAL_CAVEAT.test(content)
			|| RE_LOCAL_STDERR.test(content)) {
			return [];
		}

		// Extract command name from <command-name>/foo</command-name>
		const cmdMatch = content.match(RE_COMMAND_NAME);
		if (!cmdMatch) return [];

		const cmd = cmdMatch[1];
		// /exit is handled separately (consolidated into session ended message)
		if (cmd === '/exit') return [];

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
				if (ANSI_COMMANDS.has(label)) {
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
			for (const block of content as ClaudeContentBlock[]) {
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
		if (Array.isArray(content)) {
			const texts: string[] = [];
			for (const block of content as ClaudeContentBlock[]) {
				if (block.type === BT_TEXT && block.text?.trim()) {
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
