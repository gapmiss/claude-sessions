import { App, TFolder, normalizePath } from 'obsidian';
import { diffLines } from 'diff';
import type { Session, Turn, ContentBlock, ToolUseBlock, ToolResultBlock, SystemEvent, HookSuccessEvent, AsyncHookResponseEvent, SkillListingEvent, TaskReminderEvent, PluginSettings } from '../types';
import { fence, langFromPath, stripLineNumbers, stripFenceMarkers } from '../views/render-helpers';
import { ANSI_STRIP_RE } from '../constants';
import type { ExportOptions } from '../views/export-modal';
import { basename } from '../utils/path-utils';

interface PendingImage {
	fileName: string;
	data: string;
	mediaType: string;
}

export async function exportToMarkdown(
	app: App,
	session: Session,
	settings: PluginSettings,
	options?: ExportOptions
): Promise<string> {
	const folder = normalizePath(settings.exportFolder);

	const existing = app.vault.getAbstractFileByPath(folder);
	if (!existing) {
		await app.vault.createFolder(folder);
	} else if (!(existing instanceof TFolder)) {
		throw new Error(`${folder} exists but is not a folder.`);
	}

	const safeName = session.metadata.id
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.substring(0, 80);

	const images: PendingImage[] = [];
	const content = buildMarkdown(session, settings, safeName, images, options);

	if (images.length > 0) {
		const imgFolder = normalizePath(`${folder}/${safeName}`);
		const imgFolderExists = app.vault.getAbstractFileByPath(imgFolder);
		if (!imgFolderExists) {
			await app.vault.createFolder(imgFolder);
		}
		for (const img of images) {
			const imgPath = normalizePath(`${imgFolder}/${img.fileName}`);
			const bytes = base64ToBytes(img.data);
			const existingImg = app.vault.getAbstractFileByPath(imgPath);
			if (existingImg) {
				await app.vault.adapter.writeBinary(imgPath, bytes.buffer);
			} else {
				await app.vault.createBinary(imgPath, bytes.buffer);
			}
		}
	}

	const fileName = normalizePath(`${folder}/${safeName}.md`);
	const existingFile = app.vault.getAbstractFileByPath(fileName);
	if (existingFile) {
		await app.vault.adapter.write(fileName, content);
	} else {
		await app.vault.create(fileName, content);
	}

	return fileName;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// ── Formatters ──

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
	return String(n);
}

function fmtCost(usd: number): string {
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	return `$${usd.toFixed(3)}`;
}

function fmtDuration(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

// ── Document builder ──

function buildMarkdown(
	session: Session,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
	options?: ExportOptions,
): string {
	const lines: string[] = [];
	const meta = session.metadata;
	const stats = session.stats;

	// Frontmatter
	lines.push('---');
	lines.push(`session_id: "${meta.id}"`);
	if (meta.startTime) lines.push(`date: "${meta.startTime}"`);
	if (meta.customTitle) lines.push(`title: "${meta.customTitle}"`);
	lines.push(`project: "${meta.project}"`);
	if (meta.model) lines.push(`model: "${meta.model}"`);
	if (meta.branch) lines.push(`branch: "${meta.branch}"`);
	lines.push(`format: "${meta.format}"`);
	lines.push(`total_turns: ${meta.totalTurns}`);
	if (meta.cwd) lines.push(`cwd: "${meta.cwd}"`);
	if (meta.version) lines.push(`version: "${meta.version}"`);
	if (stats.costUSD > 0) lines.push(`cost_usd: ${stats.costUSD.toFixed(4)}`);
	if (stats.durationMs > 0) lines.push(`duration_ms: ${stats.durationMs}`);
	if (stats.inputTokens > 0) lines.push(`input_tokens: ${stats.inputTokens}`);
	if (stats.outputTokens > 0) lines.push(`output_tokens: ${stats.outputTokens}`);
	if (stats.cacheReadTokens > 0) lines.push(`cache_read_tokens: ${stats.cacheReadTokens}`);
	if (stats.cacheCreationTokens > 0) lines.push(`cache_creation_tokens: ${stats.cacheCreationTokens}`);
	if (stats.totalTokens > 0) lines.push(`total_tokens: ${stats.totalTokens}`);
	if (stats.contextWindowTokens > 0) lines.push(`context_window_tokens: ${stats.contextWindowTokens}`);
	if (stats.peakContextTokens > 0) lines.push(`peak_context_tokens: ${stats.peakContextTokens}`);
	if (stats.compactionCount > 0) lines.push(`compaction_count: ${stats.compactionCount}`);
	lines.push('---');
	lines.push('');

	// Session header
	const displayName = meta.customTitle || meta.project;
	lines.push(`# Session: ${displayName}`);
	lines.push('');

	// Summary section
	const includeSummary = options?.includeSummary ?? true;
	if (includeSummary) {
		lines.push(buildSummarySection(session));
		lines.push('');
	}

	// System events section
	const includeEvents = options?.includeSystemEvents ?? true;
	if (includeEvents && session.systemEvents.length > 0) {
		const eventsSection = buildSystemEventsSection(session.systemEvents);
		if (eventsSection) {
			lines.push(eventsSection);
			lines.push('');
		}
	}

	// Tool use map for pairing results
	const toolUseMap = new Map<string, ToolUseBlock>();
	for (const turn of session.turns) {
		for (const block of turn.contentBlocks) {
			if (block.type === 'tool_use') {
				toolUseMap.set(block.id, block);
			}
		}
	}

	for (const turn of session.turns) {
		lines.push(renderTurn(turn, settings, safeName, images, toolUseMap));
		lines.push('');
	}

	return lines.join('\n');
}

// ── Summary ──

function buildSummarySection(session: Session): string {
	const lines: string[] = [];
	const stats = session.stats;
	const meta = session.metadata;

	lines.push('## Summary');
	lines.push('');

	// Hero stats
	const heroParts: string[] = [];
	if (stats.costUSD > 0) heroParts.push(`**Cost:** ${fmtCost(stats.costUSD)}`);
	if (stats.contextWindowTokens > 0) {
		const totalContext = stats.contextWindowTokens + stats.cumulativeDroppedTokens;
		let ctx = `**Context:** ${fmtTokens(totalContext)}`;
		if (stats.compactionCount > 0 && stats.peakContextTokens > 0) {
			ctx += ` (peak: ${fmtTokens(stats.peakContextTokens)}, ${stats.compactionCount}× compacted)`;
		}
		heroParts.push(ctx);
	}
	if (meta.totalTurns > 0) heroParts.push(`**Turns:** ${meta.totalTurns}`);
	if (stats.durationMs > 0) heroParts.push(`**Duration:** ${fmtDuration(stats.durationMs)}`);
	if (heroParts.length > 0) {
		lines.push(heroParts.join(' | '));
		lines.push('');
	}

	// Token usage
	const totalInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
	if (totalInput > 0 || stats.outputTokens > 0) {
		lines.push('### Token usage');
		lines.push('');
		lines.push('| Category | Tokens |');
		lines.push('|----------|--------|');
		if (stats.cacheReadTokens > 0) lines.push(`| Cache read | ${fmtTokens(stats.cacheReadTokens)} |`);
		if (stats.cacheCreationTokens > 0) lines.push(`| Cache write | ${fmtTokens(stats.cacheCreationTokens)} |`);
		if (stats.inputTokens > 0) lines.push(`| Uncached input | ${fmtTokens(stats.inputTokens)} |`);
		if (totalInput > 0) lines.push(`| **Total input** | **${fmtTokens(totalInput)}** |`);
		if (stats.outputTokens > 0) lines.push(`| Output | ${fmtTokens(stats.outputTokens)} |`);
		lines.push('');
	}

	// Tool usage
	const toolNames = Object.keys(stats.toolUseCounts);
	if (toolNames.length > 0) {
		const sorted = toolNames.sort((a, b) => stats.toolUseCounts[b] - stats.toolUseCounts[a]);
		const totalCalls = sorted.reduce((sum, n) => sum + stats.toolUseCounts[n], 0);
		lines.push(`### Tool usage (${totalCalls} total calls)`);
		lines.push('');
		lines.push('| Tool | Count |');
		lines.push('|------|-------|');
		for (const name of sorted) {
			lines.push(`| ${name} | ${stats.toolUseCounts[name]} |`);
		}
		lines.push('');
	}

	// Session details
	lines.push('### Session details');
	lines.push('');
	if (meta.customTitle) lines.push(`- **Title:** ${meta.customTitle}`);
	if (meta.project) lines.push(`- **Project:** ${meta.project}`);
	if (meta.model) lines.push(`- **Model:** ${meta.model}`);
	if (meta.version) lines.push(`- **Version:** ${meta.version}`);
	if (meta.branch) lines.push(`- **Branch:** ${meta.branch}`);
	if (meta.startTime) lines.push(`- **Started:** ${new Date(meta.startTime).toLocaleString()}`);
	if (stats.durationMs > 0) lines.push(`- **Duration:** ${fmtDuration(stats.durationMs)}`);
	if (meta.cwd) lines.push(`- **Working dir:** ${meta.cwd}`);
	if (stats.userTurns > 0 || stats.assistantTurns > 0) {
		lines.push(`- **Turns:** ${stats.userTurns} user / ${stats.assistantTurns} assistant = ${meta.totalTurns} total`);
	}
	lines.push(`- **Session ID:** \`${meta.id}\``);
	lines.push(`- **Resume:** \`claude --resume ${meta.id}\``);
	lines.push('');

	// Parse warnings
	if (session.warnings && session.warnings.length > 0) {
		lines.push('> [!warning] Parse warnings');
		for (const w of session.warnings) {
			lines.push(`> - ${w.message} (${w.count}x)`);
		}
		if (session.warnings.some(w => w.type === 'unknown_record_type' || w.type === 'unknown_block_type')) {
			lines.push('> Some data may be missing. Check for plugin updates.');
		}
		lines.push('');
	}

	return lines.join('\n');
}

// ── System events ──

function buildSystemEventsSection(events: SystemEvent[]): string | null {
	const hooks = events.filter((e): e is HookSuccessEvent | AsyncHookResponseEvent =>
		(e.type === 'hook_success' && !e.toolUseId) || (e.type === 'async_hook_response' && !e.toolUseId));
	const skills = events.filter((e): e is SkillListingEvent => e.type === 'skill_listing');
	const tasks = events.filter((e): e is TaskReminderEvent => e.type === 'task_reminder' && e.itemCount > 0);

	if (hooks.length === 0 && skills.length === 0 && tasks.length === 0) return null;

	const lines: string[] = [];
	lines.push('## System events');
	lines.push('');

	if (hooks.length > 0) {
		lines.push(`### Hooks (${hooks.length})`);
		lines.push('');
		for (const hook of hooks) {
			const nameParts = hook.hookName.split(':');
			const eventType = nameParts[0] || hook.hookEvent;
			const toolName = nameParts[1] || '';
			const parts: string[] = [`**${eventType}**`];
			if (toolName) parts.push(toolName);
			if (hook.type === 'hook_success' && hook.durationMs > 0) parts.push(`${hook.durationMs}ms`);
			if (hook.type === 'hook_success' && hook.command) parts.push(`\`${basename(hook.command)}\``);
			if (hook.exitCode !== 0) parts.push(`exit ${hook.exitCode}`);
			lines.push(`- ${parts.join(' · ')}`);
			if (hook.stdout?.trim()) {
				const stdout = hook.stdout.trim();
				const preview = stdout.length > 200 ? stdout.slice(0, 200) + '...' : stdout;
				lines.push(`  \`\`\`\n  ${preview}\n  \`\`\``);
			}
		}
		lines.push('');
	}

	if (skills.length > 0) {
		lines.push('### Available skills');
		lines.push('');
		for (const skill of skills) {
			const skillLines = skill.content.split('\n').filter(l => l.trim().startsWith('- '));
			for (const line of skillLines) {
				const match = line.match(/^-\s+(\S+):\s*(.*)$/);
				if (match) {
					const desc = match[2].length > 80 ? match[2].slice(0, 80) + '...' : match[2];
					lines.push(`- **${match[1]}:** ${desc}`);
				}
			}
		}
		lines.push('');
	}

	if (tasks.length > 0) {
		const totalItems = tasks.reduce((sum, t) => sum + t.itemCount, 0);
		lines.push(`### Task reminders (${totalItems} items)`);
		lines.push('');
	}

	return lines.join('\n');
}

// ── Turn rendering ──

function renderTurn(
	turn: Turn,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
	toolUseMap: Map<string, ToolUseBlock>,
): string {
	const lines: string[] = [];
	const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
	const timeStr = turn.timestamp ? ` (${new Date(turn.timestamp).toLocaleString()})` : '';

	let heading = `## Turn ${turn.index + 1} — ${roleLabel}${timeStr}`;
	if (turn.isApiError) {
		const errLabel = turn.errorType === 'rate_limit' ? 'Rate limited' : 'API error';
		heading += ` ⚠ ${errLabel}`;
	}
	if (turn.stopReason === 'max_tokens') {
		heading += ' ⚠ Max tokens';
	}
	lines.push(heading);
	lines.push('');

	// Build result map so tool_use + tool_result render as pairs
	const resultMap = new Map<string, ToolResultBlock>();
	const pairedResultIds = new Set<string>();
	for (const block of turn.contentBlocks) {
		if (block.type === 'tool_result') {
			resultMap.set(block.toolUseId, block);
		}
	}

	for (const block of turn.contentBlocks) {
		// Skip tool_result blocks that will be rendered inline with their tool_use
		if (block.type === 'tool_result' && pairedResultIds.has(block.toolUseId)) {
			continue;
		}

		if (block.type === 'tool_use') {
			const result = resultMap.get(block.id);
			if (result) pairedResultIds.add(block.id);

			if (!settings.showToolCalls) continue;
			const rendered = renderToolUse(block, toolUseMap, settings, safeName, images);
			lines.push(rendered);
			lines.push('');

			// Render paired result immediately after
			if (result && settings.showToolResults) {
				const resultRendered = renderToolResult(result, safeName, images, toolUseMap);
				lines.push(resultRendered);
				lines.push('');
			}
			continue;
		}

		const rendered = renderBlock(block, settings, safeName, images, toolUseMap);
		if (rendered) {
			lines.push(rendered);
			lines.push('');
		}
	}

	return lines.join('\n');
}

function renderBlock(
	block: ContentBlock,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
	toolUseMap: Map<string, ToolUseBlock>,
): string | null {
	switch (block.type) {
		case 'text':
			return block.text;

		case 'thinking':
			if (!settings.showThinkingBlocks) return null;
			return [
				'> [!note]- Thinking',
				...block.thinking.split('\n').map(l => `> ${l}`),
			].join('\n');

		case 'tool_use':
			if (!settings.showToolCalls) return null;
			return renderToolUse(block, toolUseMap, settings, safeName, images);

		case 'tool_result':
			if (!settings.showToolResults) return null;
			return renderToolResult(block, safeName, images, toolUseMap);

		case 'image':
			return renderImage(block.mediaType, block.data, safeName, images);

		case 'ansi':
			return '```\n' + block.text.replace(ANSI_STRIP_RE, '') + '\n```';

		case 'compaction': {
			const parts = ['---', '*Context compacted*'];
			if (block.preTokens) parts.push(`Pre-compaction context: ${fmtTokens(block.preTokens)} tokens`);
			if (block.summary) parts.push(block.summary);
			parts.push('---');
			return parts.join('\n');
		}

		case 'slash_command':
			return [
				`> [!info]- Slash command: ${block.commandName}`,
				...block.text.split('\n').map(l => `> ${l}`),
			].join('\n');

		case 'bash_command': {
			const parts = ['```bash', block.command, '```'];
			if (block.stdout.trim()) {
				parts.push('```', block.stdout, '```');
			}
			if (block.stderr.trim()) {
				parts.push('> **stderr**', ...block.stderr.split('\n').map(l => `> ${l}`));
			}
			return parts.join('\n');
		}

		default:
			return null;
	}
}

// ── Tool use rendering ──

function renderToolUse(
	block: ToolUseBlock,
	toolUseMap: Map<string, ToolUseBlock>,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
): string {
	if (block.name === 'Edit') {
		return renderEditToolUse(block);
	}
	if (block.name === 'Write') {
		return renderWriteToolUse(block);
	}
	if (block.name === 'Bash') {
		return renderBashToolUse(block);
	}
	if (block.name === 'AskUserQuestion') {
		return renderAskUserQuestionToolUse(block);
	}
	if ((block.name === 'Agent' || block.name === 'Task') && block.subAgentSession) {
		return renderSubAgentToolUse(block, toolUseMap, settings, safeName, images);
	}
	if (block.name === 'Read') {
		return renderReadToolUse(block);
	}

	// Default: generic JSON input
	const toolLabel = formatToolLabel(block);
	return [
		`> [!example]- ${toolLabel}`,
		'> ```json',
		...JSON.stringify(block.input, null, 2).split('\n').map(l => `> ${l}`),
		'> ```',
	].join('\n');
}

function formatToolLabel(block: ToolUseBlock): string {
	let label = `Tool: ${block.name}`;
	if (block.isPending) label += ' (in progress)';
	else if (block.isOrphaned) label += ' (interrupted)';
	return label;
}

function renderEditToolUse(block: ToolUseBlock): string {
	const filePath = typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '';
	const oldStr = typeof block.input['old_string'] === 'string' ? block.input['old_string'] : '';
	const newStr = typeof block.input['new_string'] === 'string' ? block.input['new_string'] : '';
	const replaceAll = block.input['replace_all'] ? ' (replace all)' : '';

	const changes = diffLines(oldStr, newStr);
	const outputLines: string[] = [];
	for (const change of changes) {
		const cLines = change.value.replace(/\n$/, '').split('\n');
		const prefix = change.added ? '+ ' : change.removed ? '- ' : '  ';
		for (const line of cLines) {
			outputLines.push(prefix + line);
		}
	}

	const header = filePath ? `Edit: ${filePath}${replaceAll}` : `Edit${replaceAll}`;
	return [
		`> [!example]- ${header}`,
		'> ```diff',
		...outputLines.map(l => `> ${l}`),
		'> ```',
	].join('\n');
}

function renderWriteToolUse(block: ToolUseBlock): string {
	const filePath = typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '';
	const content = typeof block.input['content'] === 'string' ? block.input['content'] : '';
	const lang = langFromPath(filePath);
	const header = filePath ? `Write: ${filePath}` : 'Write';
	const lineCount = content.split('\n').length;

	return [
		`> [!example]- ${header} (${lineCount} lines)`,
		`> ${fence(content, lang).split('\n').join('\n> ')}`,
	].join('\n');
}

function renderBashToolUse(block: ToolUseBlock): string {
	const command = typeof block.input['command'] === 'string' ? block.input['command'] : '';
	const desc = typeof block.input['description'] === 'string' ? block.input['description'] : '';
	const header = desc ? `Bash: ${desc}` : 'Bash';

	return [
		`> [!example]- ${header}`,
		'> ```bash',
		...command.split('\n').map(l => `> ${l}`),
		'> ```',
	].join('\n');
}

function renderReadToolUse(block: ToolUseBlock): string {
	const filePath = typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '';
	const limit = block.input['limit'] as number | undefined;
	const offset = block.input['offset'] as number | undefined;
	let header = filePath ? `Read: ${filePath}` : 'Read';
	if (limit) {
		const start = offset ?? 1;
		header += ` (lines ${start}–${start + limit - 1})`;
	}
	return `> [!example]- ${header}`;
}

function renderAskUserQuestionToolUse(block: ToolUseBlock): string {
	const questions = block.input['questions'] as Array<Record<string, unknown>> | undefined;
	if (!questions?.length) {
		return `> [!question]- Ask user question\n> (no questions)`;
	}

	const lines: string[] = [];
	for (const q of questions) {
		const header = typeof q['header'] === 'string' ? q['header'] : '';
		const question = typeof q['question'] === 'string' ? q['question'] : '';
		const options = Array.isArray(q['options']) ? q['options'] as Array<Record<string, string>> : [];

		if (header) lines.push(`> **${header}**`);
		lines.push(`> ${question}`);
		if (options.length > 0) {
			lines.push('>');
			for (const opt of options) {
				const desc = opt['description'] ? ` — ${opt['description']}` : '';
				lines.push(`> - ${opt['label'] ?? ''}${desc}`);
				// Previews are ASCII mockups — fence them so alignment survives.
				// Indent by 3 to stay inside the list item; the fence strips that
				// indentation back off when rendered.
				if (opt['preview']) {
					for (const ln of fence(stripFenceMarkers(opt['preview'])).split('\n')) {
						lines.push(`>   ${ln}`);
					}
				}
			}
		}
	}
	const label = questions.length > 1 ? `Ask user (${questions.length} questions)` : 'Ask user question';
	return `> [!question]- ${label}\n${lines.join('\n')}`;
}

function renderSubAgentToolUse(
	block: ToolUseBlock,
	toolUseMap: Map<string, ToolUseBlock>,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
): string {
	const sa = block.subAgentSession!;
	const lines: string[] = [];

	const subType = sa.subagentType ? ` (${sa.subagentType})` : '';
	const desc = sa.description || block.input['description'] as string || '';
	const header = desc ? `Agent${subType}: ${desc}` : `Agent${subType}`;
	const bgLabel = sa.isBackground ? ' [background]' : '';
	const durLabel = sa.durationMs ? ` — ${fmtDuration(sa.durationMs)}` : '';
	lines.push(`> [!abstract]- ${header}${bgLabel}${durLabel}`);

	// Prompt
	lines.push('> **Prompt:**');
	const promptPreview = sa.prompt.length > 500 ? sa.prompt.slice(0, 500) + '...' : sa.prompt;
	for (const pl of promptPreview.split('\n')) {
		lines.push(`> ${pl}`);
	}
	lines.push('>');

	// Sub-agent turns
	if (sa.turns.length > 0) {
		lines.push('> **Sub-agent activity:**');
		for (const turn of sa.turns) {
			if (turn.role === 'user') continue;
			for (const tb of turn.contentBlocks) {
				const rendered = renderBlock(tb, settings, safeName, images, toolUseMap);
				if (rendered) {
					for (const rl of rendered.split('\n')) {
						lines.push(`> ${rl}`);
					}
					lines.push('>');
				}
			}
		}
	}

	return lines.join('\n');
}

// ── Tool result rendering ──

function renderToolResult(
	block: ToolResultBlock,
	safeName: string,
	images: PendingImage[],
	toolUseMap: Map<string, ToolUseBlock>,
): string {
	const toolUse = toolUseMap.get(block.toolUseId);
	const toolName = block.toolName ?? toolUse?.name ?? '';
	const label = toolName ? `Result: ${toolName}` : 'Tool result';
	const calloutType = block.isError ? 'danger' : 'success';

	const parts: string[] = [];

	if (block.content.trim()) {
		let resultText = block.content.length > 5000
			? block.content.substring(0, 5000) + '\n... (truncated)'
			: block.content;

		if (toolName === 'Read' && toolUse) {
			const filePath = typeof toolUse.input['file_path'] === 'string' ? toolUse.input['file_path'] : '';
			const lang = langFromPath(filePath);
			resultText = stripLineNumbers(resultText);
			parts.push(
				`> [!${calloutType}]- ${label}`,
				`> ${fence(resultText, lang).split('\n').join('\n> ')}`,
			);
		} else if (toolName === 'AskUserQuestion' && !block.isError) {
			// Parse structured answers
			const answerMatches = block.content.matchAll(/"([^"]+)"="([^"]+)"/g);
			const answers: Array<[string, string]> = [];
			for (const m of answerMatches) {
				if (m[1] && m[2]) answers.push([m[1], m[2]]);
			}
			if (answers.length > 0) {
				parts.push(`> [!${calloutType}]- User answers`);
				for (const [q, a] of answers) {
					parts.push(`> **${q}:** ${a}`);
				}
			} else {
				parts.push(`> [!${calloutType}]- ${label}`);
				parts.push(`> ${resultText}`);
			}
		} else if (toolName === 'ToolSearch' && !block.isError && block.enrichedResult) {
			parts.push(`> [!${calloutType}]- ${label}`);
			const matches = Array.isArray(block.enrichedResult['matches']) ? block.enrichedResult['matches'] as string[] : [];
			const total = typeof block.enrichedResult['total_deferred_tools'] === 'number' ? block.enrichedResult['total_deferred_tools'] : undefined;
			if (matches.length > 0) {
				for (const name of matches) {
					parts.push(`> - ${name}`);
				}
				if (total != null) {
					parts.push(`> ${matches.length} of ${total} deferred tools matched`);
				}
			} else {
				parts.push('> No matching tools found');
			}
		} else {
			parts.push(
				`> [!${calloutType}]- ${label}`,
				'> ```',
				...resultText.split('\n').map(l => `> ${l}`),
				'> ```',
			);
		}
	} else {
		parts.push(`> [!${calloutType}]- ${label}`);
	}

	// Enriched Bash data (stderr, exitCode)
	if (toolName === 'Bash' && block.enrichedResult) {
		const exitCode = typeof block.enrichedResult['exitCode'] === 'number' ? block.enrichedResult['exitCode'] : undefined;
		const stderr = typeof block.enrichedResult['stderr'] === 'string' ? block.enrichedResult['stderr'] : undefined;
		if (exitCode != null && exitCode !== 0) {
			parts.push(`> Exit code: ${exitCode}`);
		}
		if (stderr?.trim()) {
			const stderrText = stderr.length > 2000 ? stderr.slice(0, 2000) + '\n... (truncated)' : stderr;
			parts.push('> **stderr:**');
			parts.push('> ```');
			for (const l of stderrText.split('\n')) {
				parts.push(`> ${l}`);
			}
			parts.push('> ```');
		}
	}

	// Inline images from tool results
	if (block.images && block.images.length > 0) {
		for (const img of block.images) {
			const ref = renderImage(img.mediaType, img.data, safeName, images);
			if (ref) parts.push('>', `> ${ref}`);
		}
	}

	return parts.join('\n');
}

function renderImage(
	mediaType: string,
	data: string,
	safeName: string,
	images: PendingImage[],
): string {
	const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
	const idx = images.length + 1;
	const fileName = `image-${idx}.${ext}`;
	images.push({ fileName, data, mediaType });
	return `![image-${idx}](${safeName}/${fileName})`;
}
