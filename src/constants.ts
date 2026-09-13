// ── Record types ──────────────────────────────────────────────
export const RT_USER = 'user';
export const RT_ASSISTANT = 'assistant';
export const RT_PROGRESS = 'progress';
export const RT_QUEUE_OPERATION = 'queue-operation';
export const RT_FILE_HISTORY = 'file-history-snapshot';
export const RT_FILE_HISTORY_DELTA = 'file-history-delta';
export const RT_LAST_PROMPT = 'last-prompt';
export const RT_SUMMARY = 'summary';
export const RT_SYSTEM = 'system';
export const RT_CUSTOM_TITLE = 'custom-title';
export const RT_AGENT_NAME = 'agent-name';
export const RT_AGENT_COLOR = 'agent-color';
export const RT_MODE = 'mode';
export const RT_AI_TITLE = 'ai-title';
export const RT_PR_LINK = 'pr-link';
export const RT_COST_STATE = 'cost-state';
export const RT_ATTACHMENT = 'attachment';

/** Attachment subtype carrying a message typed while Claude was working. */
export const ATTACHMENT_QUEUED_COMMAND = 'queued_command';

export const SKIP_RECORD_TYPES = new Set([RT_FILE_HISTORY, RT_FILE_HISTORY_DELTA, RT_LAST_PROMPT, RT_PROGRESS, RT_QUEUE_OPERATION, RT_AGENT_NAME, RT_AGENT_COLOR, RT_MODE, RT_AI_TITLE, RT_PR_LINK]);

/**
 * Substring patterns for quick record type filtering (avoids JSON parsing).
 * Used by streaming-reader and session-search for performance.
 */
export const SKIP_TYPE_STRINGS = [
	'"type":"file-history-snapshot"',
	'"type":"file-history-delta"',
	'"type":"queue-operation"',
	'"type":"progress"',
	'"type":"last-prompt"',
	'"type":"custom-title"',
	'"type":"agent-name"',
	'"type":"agent-color"',
	'"type":"mode"',
	'"type":"ai-title"',
	'"type":"pr-link"',
];

/** Substring pattern for custom-title records. */
export const CUSTOM_TITLE_PATTERN = '"type":"custom-title"';

// ── Content block types ──────────────────────────────────────
export const BT_TEXT = 'text';
export const BT_THINKING = 'thinking';
export const BT_TOOL_USE = 'tool_use';
export const BT_TOOL_RESULT = 'tool_result';
export const BT_IMAGE = 'image';

// ── Progress data subtypes ───────────────────────────────────
export const PROGRESS_AGENT = 'agent_progress';

// ── Sub-agent tool names ─────────────────────────────────────
// STRUCTURAL ASSUMPTION: only these tool names trigger sub-agent session
// resolution. If Claude Code introduces new agent tool names, add them here.
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

// ── Reviewed attachment subtypes ─────────────────────────────
// Attachment subtypes we looked at and chose not to render. Each entry records
// why, so a later reader can tell a decision from a shrug. Anything absent from
// this map still raises an `unknown_attachment_type` warning — that warning is
// what would have caught the `hook_permission_decision` change in CC 2.1.214,
// so do not add an entry here just to silence noise.
//
// Criterion: does the record carry information that appears nowhere else in the
// timeline and changes what a reader understands happened? If yes, render it.
export const REVIEWED_ATTACHMENT_TYPES = new Map<string, string>([
	['deferred_tools_delta', 'Harness bookkeeping — tool-schema churn, no bearing on what happened in the session'],
	['agent_listing_delta', 'Harness bookkeeping — available-agent churn; actual agent runs appear as Agent tool calls'],
	['compact_file_reference', 'Path only, no content; the file is visible via the tool call that read it'],
	['already_read_file', 'Cache hit marker (content is `file_unchanged`); the original read is already in the timeline'],
	['directory', 'Directory listing from an @-mention; the same paths surface through the tool calls that follow'],
	['plan_file_reference', 'Plan text is already rendered via plan_mode_exit and the ExitPlanMode tool call'],
	['companion_intro', 'Cosmetic — names the terminal companion, carries no session information'],
	['total_tokens_reminder', 'Context-budget banner injected each turn; the token counts it tracks are already in session stats'],
	['edited_text_file', 'Fires whenever a file changes on disk, including edits made by a Bash command in this same session, so "edited outside Claude Code" would be wrong as often as right'],
	['file', 'Contents of an @-mentioned file. The user attached it and the prompt referencing it is already in the timeline'],
	['diagnostics', 'LSP errors shown to Claude. Re-sent on every turn until fixed, so a single unresolved error produces hundreds of records'],
	['plan_mode', 'Mode transition only; the plan itself renders via the ExitPlanMode tool call'],
	['plan_mode_exit', 'Mode transition only; the plan itself renders via the ExitPlanMode tool call'],
	['invoked_skills', 'The skill invocation is already visible in the transcript that triggered it'],
	['environment', 'Working directory, platform, shell, OS — already extracted into session metadata (cwd, model, version)'],
	['model', 'Model identity (id, marketing name, cutoff) — already extracted into session metadata'],
	['instructions', 'CLAUDE.md file paths and contents — already visible as system-reminder tags in the transcript'],
	['session_context', 'User email, git status — already visible as system-reminder tags in the transcript'],
	['date', 'Current date — already visible as a system-reminder tag in the transcript'],
	['remote_session_change', 'Commit/PR attribution config and managed-operation flags — harness config, not a session event'],
	['prompt_snapshot', 'Full system prompt array — the prompt text is already in the transcript as system-reminder tags'],
	['deferred_tools_record', 'Full tool schemas for deferred tools — same category as deferred_tools_delta (harness bookkeeping)'],
]);

// Record types we looked at and chose not to render, same criterion and same
// warning behaviour as REVIEWED_ATTACHMENT_TYPES above.
export const REVIEWED_RECORD_TYPES = new Map<string, string>([
	['atis-latch', 'Empty payload (`atis` is always an empty string) plus the session id — harness bookkeeping'],
	['cost-state', 'Session totals. The summary panel already shows cost and token counts from per-turn usage'],
]);

// ── Special model values ─────────────────────────────────────
export const MODEL_SYNTHETIC = '<synthetic>';

// ── System record subtypes ───────────────────────────────────
export const SUBTYPE_LOCAL_COMMAND = 'local_command';

// ── XML tags (Claude Code internal protocol) ─────────────────
// STRUCTURAL ASSUMPTION: these tags are parsed via regex (see RE_* constants below).
// If Claude Code changes its XML schema, update both the tag strings and regexes.
export const TAG_TASK_NOTIFICATION = '<task-notification>';
export const TAG_COMMAND_MESSAGE_OPEN = '<command-message>';

// ── XML tag regexes (reusable, compiled once) ────────────────
export const RE_COMMAND_NAME = /<command-name>(\/[\w:./-]+)<\/command-name>/;
export const RE_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
export const RE_EXIT_COMMAND = /^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\/exit<\/command-name>/;
export const RE_SLASH_COMMAND = /^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>(\/[\w:./-]+)<\/command-name>/;
export const RE_LOCAL_STDOUT = /^<local-command-stdout>/;
export const RE_LOCAL_CAVEAT = /^<local-command-caveat>/;
export const RE_LOCAL_STDERR = /^<local-command-stderr>/;
export const RE_SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
export const RE_COMMAND_MESSAGE_STRIP = /<command-message>[\s\S]*?<\/command-message>/g;
export const RE_COMMAND_ARGS_STRIP = /<command-args>[\s\S]*?<\/command-args>/g;
export const RE_IMAGE_REF = /\[Image:\s*source:\s*.+?\]/gi;
export const RE_TOOL_USE_ERROR = /^<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/;
export const RE_LOCAL_STDOUT_TAGS = /<\/?local-command-stdout>/g;

// ── User bash command tags ──────────────────────────────────
export const RE_BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/;
export const RE_BASH_STDOUT = /^<bash-stdout>([\s\S]*?)<\/bash-stdout>/;
export const RE_BASH_STDERR = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/;

// ── Task notification XML tag regexes ────────────────────────
export const RE_TN_TOOL_USE_ID = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/;
export const RE_TN_TASK_ID = /<task-id>([\s\S]*?)<\/task-id>/;
export const RE_TN_RESULT = /<result>([\s\S]*?)<\/result>/;
export const RE_TN_SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
export const RE_TN_DURATION = /<duration_ms>([\s\S]*?)<\/duration_ms>/;

// ── Agent ID extraction (from tool_result text) ────────────
export const RE_AGENT_ID = /agentId:\s*(\S+)/;

// ── Display strings ──────────────────────────────────────────
export const TEXT_SESSION_ENDED = '*Session ended*';
export const TEXT_INTERRUPTION = '*Request interrupted by user*';
export const PREFIX_INTERRUPTION = '[Request interrupted by user';

// ── ANSI escape code patterns ──────────────────────────────
const ESC = String.fromCharCode(0x1b);
/** Test whether text contains ANSI escape codes */
export const ANSI_RE = new RegExp(ESC + '\\[' + '[\\d;]*m');
/** Strip all ANSI escape codes (global) */
export const ANSI_STRIP_RE = new RegExp(ESC + '\\[' + '[\\d;]*m', 'g');
/** Parse ANSI escape codes with capture group (global) */
export const ANSI_PARSE_RE = new RegExp(ESC + '\\[' + '([\\d;]*)m', 'g');

// ── Commands with ANSI output ────────────────────────────────
export const ANSI_COMMANDS = new Set(['/context']);

// ── Task management tool names ──────────────────────────────
export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

// ── Duration calculation ────────────────────────────────────
/** Gap threshold (30 min) — gaps larger than this are excluded from active duration */
export const DURATION_GAP_THRESHOLD_MS = 30 * 60 * 1000;
