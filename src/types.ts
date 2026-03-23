export type SessionFormat = 'claude';
export type TurnRole = 'user' | 'assistant';
export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'ansi' | 'compaction';

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
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
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

export interface ToolResultBlock {
	type: 'tool_result';
	toolUseId: string;
	toolName?: string;
	content: string;
	isError: boolean;
	timestamp?: string;
	enrichedResult?: Record<string, unknown>;
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
	timestamp?: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock | AnsiBlock | CompactionBlock;

export interface PluginSettings {
	sessionDirs: string[];
	exportFolder: string;
	showThinkingBlocks: boolean;
	showToolCalls: boolean;
	showToolResults: boolean;
	showHookIcons: boolean;
	autoScrollOnUpdate: boolean;
	defaultExportFormat: 'markdown' | 'html';
	toolGroupThreshold: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	sessionDirs: ['~/.claude/projects'],
	exportFolder: 'agent-sessions',
	showThinkingBlocks: true,
	showToolCalls: true,
	showToolResults: true,
	showHookIcons: true,
	autoScrollOnUpdate: true,
	defaultExportFormat: 'markdown',
	toolGroupThreshold: 4,
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
