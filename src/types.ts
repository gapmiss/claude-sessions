export type SessionFormat = 'claude';
export type TurnRole = 'user' | 'assistant';

export interface SessionMetadata {
	id: string;
	format: SessionFormat;
	project: string;
	cwd: string;
	branch?: string;
	model?: string;
	version?: string;
	startTime?: string;
	totalTurns: number;
	/** User-defined session name from /rename command. */
	customTitle?: string;
}

export interface SessionStats {
	userTurns: number;
	assistantTurns: number;
	/** Cumulative uncached input tokens across all API calls. */
	inputTokens: number;
	/** Cumulative output tokens across all API calls. */
	outputTokens: number;
	/** Cumulative cache-read input tokens across all API calls. */
	cacheReadTokens: number;
	/** Cumulative cache-creation input tokens across all API calls. */
	cacheCreationTokens: number;
	/** Cumulative total tokens (input + output + cache read + cache write). */
	totalTokens: number;
	/** Context window size at the final API call (input + cache read + cache write). */
	contextWindowTokens: number;
	/** Peak context window size before any compaction (0 if never compacted). */
	peakContextTokens: number;
	/** Cumulative tokens dropped by compactions (from compact_boundary metadata). */
	cumulativeDroppedTokens: number;
	/** Number of times the session was compacted. */
	compactionCount: number;
	/** Estimated session cost in USD (model-aware pricing). */
	costUSD: number;
	toolUseCounts: Record<string, number>;
	durationMs: number;
}

/** H4: Parse warning surfaced to UI. */
export interface ParseWarning {
	type: 'unknown_record_type' | 'unknown_block_type' | 'unknown_attachment_type' | 'parse_errors';
	message: string;
	count: number;
}

export interface Session {
	metadata: SessionMetadata;
	stats: SessionStats;
	turns: Turn[];
	systemEvents: SystemEvent[];
	rawPath: string;
	/** H4: Parse warnings to surface in UI (unknown types, format changes). */
	warnings?: ParseWarning[];
}

// ── System Events ──

export type SystemEventType = 'permission-mode' | 'skill_listing' | 'hook_success' | 'async_hook_response' | 'hook_permission_decision' | 'output_style' | 'command_permissions' | 'task_reminder'
	| 'read_truncation_notice' | 'hook_blocking_error' | 'hook_non_blocking_error' | 'stop_hook_summary';

export interface BaseSystemEvent {
	type: SystemEventType;
	uuid: string;
	timestamp: string;
	parentUuid?: string;
}

export interface PermissionModeEvent extends BaseSystemEvent {
	type: 'permission-mode';
	permissionMode: string;
	/** 0-based index of the turn in progress when the mode took effect. The record has no timestamp. */
	turnIndex: number;
}

/**
 * Stop hooks that ran at the end of a turn, from a `system` record with
 * subtype `stop_hook_summary`. This is the only place Stop hooks are recorded.
 */
export interface StopHookSummaryEvent extends BaseSystemEvent {
	type: 'stop_hook_summary';
	hooks: { command: string; durationMs?: number }[];
	errors: string[];
	preventedContinuation: boolean;
}

export interface SkillListingEvent extends BaseSystemEvent {
	type: 'skill_listing';
	content: string;
	skillCount: number;
	isInitial?: boolean;
}

export interface HookSuccessEvent extends BaseSystemEvent {
	type: 'hook_success';
	hookName: string;
	hookEvent: string;
	command: string;
	durationMs: number;
	stdout: string;
	stderr: string;
	exitCode: number;
	toolUseId?: string;
}

export interface AsyncHookResponseEvent extends BaseSystemEvent {
	type: 'async_hook_response';
	hookName: string;
	hookEvent: string;
	processId: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	toolUseId?: string;
}

/**
 * PermissionRequest hook outcome. Emitted by Claude Code 2.1.214+ as an
 * `attachment` record with subtype `hook_permission_decision`; earlier versions
 * reported the same thing as an `async_hook_response` with hookName
 * "PermissionRequest:<Tool>". Carries no stdout, duration, or command — only
 * the decision — so it renders as a header indicator, not a HOOKS detail row.
 */
export interface HookPermissionDecisionEvent extends BaseSystemEvent {
	type: 'hook_permission_decision';
	hookEvent: string;
	decision: 'allow' | 'deny';
	toolUseId?: string;
}

/**
 * Active output style. Claude Code stamps this on nearly every attachment
 * record (5,000+ per vault is normal), but the value is session-constant.
 * The parser emits one event per distinct value, so a mid-session style
 * switch still produces a second event.
 */
export interface OutputStyleEvent extends BaseSystemEvent {
	type: 'output_style';
	style: string;
}

/**
 * Tools a slash command pre-authorized via its `allowed-tools` frontmatter.
 * Nearly always empty (266 of 268 records across a real vault), so the parser
 * emits an event only when the list has entries.
 */
export interface CommandPermissionsEvent extends BaseSystemEvent {
	type: 'command_permissions';
	allowedTools: string[];
	/** Slash command that requested the grant, resolved by walking the parent chain. */
	commandName?: string;
}

export interface TaskReminderEvent extends BaseSystemEvent {
	type: 'task_reminder';
	content: unknown[];
	itemCount: number;
}

/**
 * A Read result that was cut short. Without this the timeline shows a complete-
 * looking tool result with no hint that Claude saw only part of the file.
 * `toolUseID` is authoritative — no parent-chain walk needed.
 */
export interface ReadTruncationNoticeEvent extends BaseSystemEvent {
	type: 'read_truncation_notice';
	banner: string;
	toolUseId?: string;
}

/** A hook that failed and blocked the tool call. */
export interface HookBlockingErrorEvent extends BaseSystemEvent {
	type: 'hook_blocking_error';
	hookName: string;
	hookEvent: string;
	blockingError: string;
	toolUseId?: string;
}

/** A hook that failed while the tool ran anyway. Carries the full hook_success field set. */
export interface HookNonBlockingErrorEvent extends BaseSystemEvent {
	type: 'hook_non_blocking_error';
	hookName: string;
	hookEvent: string;
	command: string;
	durationMs: number;
	stdout: string;
	stderr: string;
	exitCode: number;
	toolUseId?: string;
}

export type SystemEvent = PermissionModeEvent | SkillListingEvent | HookSuccessEvent | AsyncHookResponseEvent | HookPermissionDecisionEvent | OutputStyleEvent | CommandPermissionsEvent | TaskReminderEvent
	| ReadTruncationNoticeEvent | HookBlockingErrorEvent | HookNonBlockingErrorEvent | StopHookSummaryEvent;

export interface Turn {
	index: number;
	role: TurnRole;
	timestamp?: string;
	endTimestamp?: string;
	contentBlocks: ContentBlock[];
	model?: string;
	stopReason?: string;
	isApiError?: boolean;
	errorType?: string;
}

export interface TextBlock {
	type: 'text';
	text: string;
	timestamp?: string;
}

export interface ThinkingBlock {
	type: 'thinking';
	thinking: string;
	timestamp?: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
	timestamp?: string;
	subAgentSession?: SubAgentSession;
	isOrphaned?: boolean;
	isPending?: boolean;
}

export interface SubAgentSession {
	agentId: string;
	description?: string;
	subagentType?: string;
	prompt: string;
	turns: Turn[];
	isBackground?: boolean;
	durationMs?: number;
}

export interface ToolResultImage {
	mediaType: string;
	data: string;
}

export interface ToolResultBlock {
	type: 'tool_result';
	toolUseId: string;
	toolName?: string;
	content: string;
	isError: boolean;
	timestamp?: string;
	enrichedResult?: Record<string, unknown>;
	images?: ToolResultImage[];
}

export interface ImageBlock {
	type: 'image';
	mediaType: string;
	data: string;
	timestamp?: string;
}

/**
 * A message the user sent while Claude was still working, which Claude Code
 * absorbed into the running turn. Recorded only as a `queued_command`
 * attachment — no user record exists for it — so without this block the
 * message is invisible in the timeline. Rendered inline at the point it
 * landed, inside the assistant turn, rather than as a turn of its own.
 */
export interface QueuedMessageBlock {
	type: 'queued_message';
	text: string;
	images: { mediaType: string; data: string }[];
	timestamp?: string;
}

export interface AnsiBlock {
	type: 'ansi';
	label: string;
	text: string;
	timestamp?: string;
}

export interface CompactionBlock {
	type: 'compaction';
	summary?: string;
	preTokens?: number;
	timestamp?: string;
}

export interface SlashCommandBlock {
	type: 'slash_command';
	commandName: string;
	text: string;
	timestamp?: string;
}

export interface BashCommandBlock {
	type: 'bash_command';
	command: string;
	stdout: string;
	stderr: string;
	timestamp?: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock | AnsiBlock | CompactionBlock | SlashCommandBlock | BashCommandBlock | QueuedMessageBlock;

export interface PluginSettings {
	sessionDirs: string[];
	exportFolder: string;
	showThinkingBlocks: boolean;
	showToolCalls: boolean;
	showToolResults: boolean;

	autoScrollOnUpdate: boolean;
	notifyOnPendingTool: boolean;
	toolGroupThreshold: number;
	maxContentWidth: number;
	debugLevel: 'none' | 'error' | 'warn' | 'info' | 'debug';
	pinnedSessions: string[];
	showRateLimits: boolean;

	// Export options (persisted from export modal)
	exportIncludeSummary: boolean;
	exportIncludeSystemEvents: boolean;

	// Distill settings
	distillFolder: string;
	basesFolder: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	sessionDirs: ['~/.claude/projects'],
	exportFolder: 'Claude sessions',
	showThinkingBlocks: true,
	showToolCalls: true,
	showToolResults: true,

	autoScrollOnUpdate: true,
	notifyOnPendingTool: false,
	toolGroupThreshold: 4,
	maxContentWidth: 960,
	debugLevel: 'warn',
	pinnedSessions: [],
	showRateLimits: false,

	// Export options
	exportIncludeSummary: true,
	exportIncludeSystemEvents: true,

	// Distill settings
	distillFolder: 'Claude sessions/distilled',
	basesFolder: 'Claude sessions/bases',
};

export interface SessionListEntry {
	id: string;
	project: string;
	format: SessionFormat;
	date?: string;
	path: string;
	cwd?: string;
	startTime?: string;
	mtime: number;
	/** User-defined session name from /rename command. */
	customTitle?: string;
}

export interface CachedSessionMeta {
	sessionId?: string;
	cwd?: string;
	startTime?: string;
	hasContent: boolean;
	mtime: number;
	/** User-defined session name from /rename command. */
	customTitle?: string;
}

export interface SessionIndexData {
	version: number;
	entries: Record<string, CachedSessionMeta>;
}
