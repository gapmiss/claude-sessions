// ── Record types ──────────────────────────────────────────────
export const RT_USER = 'user';
export const RT_ASSISTANT = 'assistant';
export const RT_PROGRESS = 'progress';
export const RT_QUEUE_OPERATION = 'queue-operation';
export const RT_FILE_HISTORY = 'file-history-snapshot';
export const RT_SUMMARY = 'summary';
export const RT_SYSTEM = 'system';

export const SKIP_RECORD_TYPES = new Set([RT_FILE_HISTORY, RT_PROGRESS, RT_QUEUE_OPERATION]);

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
