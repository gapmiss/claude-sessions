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
	/** Estimated session cost in USD (model-aware pricing). */
	costUSD: number;
	toolUseCounts: Record<string, number>;
	durationMs: number;
}

export interface Session {
	metadata: SessionMetadata;
	stats: SessionStats;
	turns: Turn[];
	rawPath: string;
}

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

export interface HookEvent {
	hookEvent: string;
	hookName: string;
	timestamp?: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
	timestamp?: string;
	hooks?: HookEvent[];
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

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock | AnsiBlock | CompactionBlock | SlashCommandBlock | BashCommandBlock;

export interface PluginSettings {
	sessionDirs: string[];
	exportFolder: string;
	showThinkingBlocks: boolean;
	showToolCalls: boolean;
	showToolResults: boolean;
	showHookIcons: boolean;
	autoScrollOnUpdate: boolean;
	notifyOnPendingTool: boolean;
	toolGroupThreshold: number;
	pinSummaryDashboard: boolean;
	maxContentWidth: number;
	debugLevel: 'none' | 'error' | 'warn' | 'info' | 'debug';
	pinnedSessions: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
	sessionDirs: ['~/.claude/projects'],
	exportFolder: 'Claude sessions',
	showThinkingBlocks: true,
	showToolCalls: true,
	showToolResults: true,
	showHookIcons: true,
	autoScrollOnUpdate: true,
	notifyOnPendingTool: false,
	toolGroupThreshold: 4,
	pinSummaryDashboard: false,
	maxContentWidth: 960,
	debugLevel: 'warn',
	pinnedSessions: [],
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
}

export interface CachedSessionMeta {
	sessionId?: string;
	cwd?: string;
	startTime?: string;
	hasContent: boolean;
	mtime: number;
}

export interface SessionIndexData {
	version: number;
	entries: Record<string, CachedSessionMeta>;
}
