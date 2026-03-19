export type SessionFormat = 'claude' | 'cursor' | 'codex';
export type TurnRole = 'user' | 'assistant';
export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result';

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

export interface Session {
	metadata: SessionMetadata;
	turns: Turn[];
	rawPath: string;
}

export interface Turn {
	index: number;
	role: TurnRole;
	timestamp?: string;
	contentBlocks: ContentBlock[];
}

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ThinkingBlock {
	type: 'thinking';
	thinking: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResultBlock {
	type: 'tool_result';
	toolUseId: string;
	toolName?: string;
	content: string;
	isError: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface PluginSettings {
	sessionDirs: string[];
	exportFolder: string;
	showThinkingBlocks: boolean;
	showToolCalls: boolean;
	showToolResults: boolean;
	playbackSpeed: number;
	defaultExportFormat: 'markdown' | 'html';
}

export const DEFAULT_SETTINGS: PluginSettings = {
	sessionDirs: ['~/.claude/projects'],
	exportFolder: 'agent-sessions',
	showThinkingBlocks: true,
	showToolCalls: true,
	showToolResults: true,
	playbackSpeed: 1,
	defaultExportFormat: 'markdown',
};

export interface SessionListEntry {
	id: string;
	project: string;
	format: SessionFormat;
	date?: string;
	path: string;
}
