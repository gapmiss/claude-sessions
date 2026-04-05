import { MarkdownRenderer, setIcon } from 'obsidian';
import { diffLines } from 'diff';
import type { ContentBlock, ToolUseBlock, ToolResultBlock, ToolResultImage, SubAgentSession } from '../types';
import { TASK_TOOL_NAMES } from '../constants';
import {
	type RenderContext, COLLAPSE_THRESHOLD,
	makeClickable, fence, langFromPath, stripLineNumbers, addCopyButton,
} from './render-helpers';

/** Accumulated task state for rendering cumulative task lists. */
export interface TaskState {
	id: string;
	subject: string;
	status: 'pending' | 'in_progress' | 'completed';
}

/** Callbacks into the main renderer for recursive rendering. */
export interface ToolRendererDelegate {
	renderAssistantBlocks(blocks: ContentBlock[], container: HTMLElement, startBlockIdx: number, groupThreshold?: number): void;
	renderTextContent(text: string, container: HTMLElement, cls: string): void;
	buildAnsiDom(text: string, parent: HTMLElement): void;
	openImageModal(dataUri: string, mediaType: string): void;
	taskState: Map<string, TaskState>;
}

export function renderToolGroup(
	blocks: ContentBlock[],
	container: HTMLElement,
	ctx: RenderContext,
	delegate: ToolRendererDelegate,
	groupThreshold?: number,
): void {
	const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
	const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');

	const resultMap = new Map<string, ToolResultBlock>();
	for (const r of toolResults) {
		resultMap.set(r.toolUseId, r);
	}

	if (!ctx.settings.showToolCalls) return;

	const threshold = groupThreshold ?? ctx.settings.toolGroupThreshold;
	if (toolUses.length <= threshold) {
		for (const tu of toolUses) {
			renderToolCall(tu, resultMap.get(tu.id), container, ctx, delegate);
		}
	} else {
		const groupEl = container.createDiv({ cls: 'claude-sessions-tool-group' });
		const groupHeader = groupEl.createDiv({ cls: 'claude-sessions-tool-group-header' });
		groupHeader.createSpan({ cls: 'claude-sessions-tool-group-chevron', text: '\u25B6' });

		const uniqueNames = [...new Set(toolUses.map(t => t.name))].join(', ');
		const hasError = toolResults.some(r => r.isError);
		if (hasError) {
			groupHeader.createSpan({ cls: 'claude-sessions-tool-indicator claude-sessions-tool-error' });
		}
		groupHeader.createSpan({ text: `${toolUses.length} tool calls ` });
		groupHeader.createSpan({ cls: 'claude-sessions-tool-group-names', text: uniqueNames });

		const groupBody = groupEl.createDiv({ cls: 'claude-sessions-tool-group-body' });

		makeClickable(groupHeader, { label: `Toggle ${toolUses.length} tool calls`, expanded: false });
		groupHeader.addEventListener('click', () => {
			const willOpen = !groupEl.hasClass('open');
			groupEl.toggleClass('open', willOpen);
			groupHeader.setAttribute('aria-expanded', String(willOpen));
		});

		for (const tu of toolUses) {
			renderToolCall(tu, resultMap.get(tu.id), groupBody, ctx, delegate);
		}
	}
}

export function renderToolCall(
	block: ToolUseBlock,
	result: ToolResultBlock | undefined,
	container: HTMLElement,
	ctx: RenderContext,
	delegate: ToolRendererDelegate,
): void {
	const toolEl = container.createDiv({ cls: 'claude-sessions-tool-block' });

	// Header bar
	const header = toolEl.createDiv({ cls: 'claude-sessions-tool-header' });
	const isError = result?.isError ?? false;
	const indicatorCls = (block.isOrphaned || block.isPending)
		? 'claude-sessions-tool-indicator claude-sessions-tool-orphaned'
		: `claude-sessions-tool-indicator ${isError ? 'claude-sessions-tool-error' : ''}`;
	header.createSpan({ cls: indicatorCls });
	const mcpParts = parseMcpToolName(block.name);
	if (mcpParts) {
		header.createSpan({ cls: 'claude-sessions-tool-mcp-server', text: mcpParts.server });
		header.createSpan({ cls: 'claude-sessions-tool-name', text: mcpParts.tool });
	} else {
		header.createSpan({ cls: 'claude-sessions-tool-name', text: block.name });
	}
	header.createSpan({ cls: 'claude-sessions-tool-preview', text: toolPreview(block) });
	if (block.isPending) {
		header.createSpan({ cls: 'claude-sessions-tool-duration claude-sessions-tool-orphaned-label', text: 'in progress' });
	} else if (block.isOrphaned) {
		header.createSpan({ cls: 'claude-sessions-tool-duration claude-sessions-tool-orphaned-label', text: 'interrupted' });
	} else if (block.subAgentSession?.isBackground && block.subAgentSession.durationMs) {
		// Completed background agent — show actual run duration, not the instant tool call time
		header.createSpan({
			cls: 'claude-sessions-tool-duration',
			text: formatToolDuration(block.subAgentSession.durationMs),
		});
	} else if (block.timestamp && result?.timestamp) {
		const elapsed = new Date(result.timestamp).getTime() - new Date(block.timestamp).getTime();
		if (elapsed > 0 && !isNaN(elapsed)) {
			header.createSpan({ cls: 'claude-sessions-tool-duration', text: formatToolDuration(elapsed) });
		}
	}
	if (block.subAgentSession?.isBackground && !block.subAgentSession.durationMs) {
		// Still running — show "background" badge
		header.createSpan({
			cls: 'claude-sessions-tool-duration claude-sessions-tool-background-label',
			text: 'background',
		});
	}
	header.createSpan({ cls: 'claude-sessions-tool-chevron', text: '\u25B6' });

	// Body (hidden by default)
	const body = toolEl.createDiv({ cls: 'claude-sessions-tool-body' });

	// Input section
	if ((block.name === 'Agent' || block.name === 'Task') && block.subAgentSession) {
		renderSubAgentSession(block.subAgentSession, body, result, ctx, delegate);
	} else if (block.name === 'Edit' && block.input['old_string'] != null) {
		renderDiffView(block, result, body, ctx);
	} else if (block.name === 'Write' && block.input['content'] != null) {
		renderWriteView(block, result, body, ctx);
	} else if (block.name === 'Bash') {
		renderBashInput(block, body, ctx);
	} else if (Object.keys(block.input).length > 0) {
		const inputEl = body.createDiv({ cls: 'claude-sessions-tool-input' });
		inputEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'INPUT' });
		const inputText = formatInput(block.input);
		const inputMd = fence(inputText, 'json');
		const inputMdContainer = inputEl.createDiv({ cls: 'claude-sessions-tool-input-code' });
		MarkdownRenderer.render(ctx.app, inputMd, inputMdContainer, '', ctx.component);
	}

	// Result section (skip for Edit/Write/Agent which render their own results)
	if (result && ctx.settings.showToolResults
		&& !(block.name === 'Edit' && block.input['old_string'] != null)
		&& !(block.name === 'Write' && block.input['content'] != null)
		&& !((block.name === 'Agent' || block.name === 'Task') && block.subAgentSession)) {
		renderToolResult(block, result, isError, body, ctx, delegate);
	}

	makeClickable(header, { label: `Toggle ${block.name} details`, expanded: false });
	header.addEventListener('click', () => {
		const willOpen = !toolEl.hasClass('open');
		toolEl.toggleClass('open', willOpen);
		header.setAttribute('aria-expanded', String(willOpen));
	});
}

function hasAnsiCodes(text: string): boolean {
	return /\x1b\[[\d;]*m/.test(text);
}

function renderToolResult(
	block: ToolUseBlock,
	result: ToolResultBlock,
	isError: boolean,
	body: HTMLElement,
	ctx: RenderContext,
	delegate: ToolRendererDelegate,
): void {
	const resultEl = body.createDiv({
		cls: `claude-sessions-tool-result ${isError ? 'claude-sessions-tool-result-error' : ''}`,
	});
	resultEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'RESULT' });
	const resultText = result.content.length > 5000
		? result.content.substring(0, 5000) + '\n... (truncated)'
		: result.content;

	if (TASK_TOOL_NAMES.has(block.name) && !isError && result.enrichedResult) {
		renderTaskResult(block, result.enrichedResult, resultEl, delegate);
	} else if (result.images && result.images.length > 0) {
		renderToolResultImages(result.images, resultEl, delegate);
		if (resultText) {
			const md = fence(resultText);
			const mdContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code' });
			MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
		}
	} else if (block.name === 'Read' && !isError) {
		const filePath = String(block.input['file_path'] || '');
		const lang = langFromPath(filePath);
		const cleaned = stripLineNumbers(resultText);
		const isMarkdownFile = /\.mdx?$/i.test(filePath);

		if (isMarkdownFile) {
			renderMarkdownToggle(cleaned, lang, resultEl, ctx);
		} else {
			const md = fence(cleaned, lang);
			const mdContainer = resultEl.createDiv({ cls: 'claude-sessions-read-result' });
			MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
		}
	} else if (block.name === 'Bash' && !isError && isBashDiffResult(block, resultText)) {
		const resultMd = fence(resultText, 'diff');
		const resultMdContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code' });
		MarkdownRenderer.render(ctx.app, resultMd, resultMdContainer, '', ctx.component);
	} else if (block.name === 'Bash' && !isError && hasAnsiCodes(resultText)) {
		const pre = resultEl.createEl('pre', { cls: 'claude-sessions-ansi-block' });
		delegate.buildAnsiDom(resultText, pre);
	} else {
		const resultMd = fence(resultText);
		const resultMdContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code' });
		MarkdownRenderer.render(ctx.app, resultMd, resultMdContainer, '', ctx.component);
	}

	// Show enriched data (Bash exit code + stderr)
	if (block.name === 'Bash' && result.enrichedResult) {
		const exitCode = result.enrichedResult['exitCode'];
		const stderr = result.enrichedResult['stderr'] as string | undefined;
		if (exitCode != null && exitCode !== 0) {
			resultEl.createDiv({ cls: 'claude-sessions-tool-exit-code', text: `Exit code: ${exitCode}` });
		}
		if (stderr?.trim()) {
			const stderrLabel = resultEl.createDiv({ cls: 'claude-sessions-tool-section-label' });
			stderrLabel.createSpan({ text: 'STDERR' });
			const stderrText = stderr.length > 2000
				? stderr.substring(0, 2000) + '\n... (truncated)'
				: stderr;
			const stderrMd = fence(stderrText);
			const stderrContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code claude-sessions-tool-result-error' });
			MarkdownRenderer.render(ctx.app, stderrMd, stderrContainer, '', ctx.component);
		}
	}
}

function renderToolResultImages(
	images: ToolResultImage[],
	container: HTMLElement,
	delegate: ToolRendererDelegate,
): void {
	for (const image of images) {
		const dataUri = `data:${image.mediaType};base64,${image.data}`;
		const img = container.createEl('img', {
			cls: 'claude-sessions-image-thumbnail',
			attr: { src: dataUri, alt: 'Tool result image' },
		});
		makeClickable(img, { label: 'View tool result image' });
		img.addEventListener('click', () => {
			delegate.openImageModal(dataUri, image.mediaType);
		});
	}
}

// ── Task tool rendering ─────────────────────────────────────

const TASK_STATUS_ICON: Record<string, string> = {
	pending: 'circle',
	in_progress: 'circle-dot',
	completed: 'circle-check',
};

const TASK_STATUS_CLS: Record<string, string> = {
	pending: 'pending',
	in_progress: 'in-progress',
	completed: 'completed',
};

function renderTaskResult(
	block: ToolUseBlock,
	enriched: Record<string, unknown>,
	container: HTMLElement,
	delegate: ToolRendererDelegate,
): void {
	const ts = delegate.taskState;

	// Update cumulative state based on tool type
	if (block.name === 'TaskCreate' && enriched['task']) {
		const t = enriched['task'] as Record<string, unknown>;
		const id = String(t['id']);
		ts.set(id, { id, subject: String(t['subject'] || ''), status: 'pending' });
	} else if (block.name === 'TaskUpdate' && enriched['taskId']) {
		const id = String(enriched['taskId']);
		const existing = ts.get(id);
		const sc = enriched['statusChange'] as Record<string, string> | undefined;
		const status = (sc?.['to'] || existing?.status || 'pending') as TaskState['status'];
		ts.set(id, { id, subject: existing?.subject || '', status });
	} else if (block.name === 'TaskList' && Array.isArray(enriched['tasks'])) {
		ts.clear();
		for (const t of enriched['tasks'] as Record<string, unknown>[]) {
			const id = String(t['id']);
			ts.set(id, {
				id,
				subject: String(t['subject'] || ''),
				status: (String(t['status'] || 'pending')) as TaskState['status'],
			});
		}
	} else if (block.name === 'TaskGet' && enriched['id']) {
		const id = String(enriched['id']);
		const existing = ts.get(id);
		ts.set(id, {
			id,
			subject: String(enriched['subject'] || existing?.subject || ''),
			status: (String(enriched['status'] || existing?.status || 'pending')) as TaskState['status'],
		});
	}

	if (ts.size === 0) return;

	// Render full cumulative task list
	const list = container.createDiv({ cls: 'claude-sessions-task-list' });
	for (const task of ts.values()) {
		const statusCls = TASK_STATUS_CLS[task.status] || 'pending';
		const item = list.createDiv({ cls: `claude-sessions-task-item claude-sessions-task-${statusCls}` });
		const icon = item.createSpan({ cls: 'claude-sessions-task-icon' });
		setIcon(icon, TASK_STATUS_ICON[task.status] || 'circle');
		const label = item.createSpan({ cls: 'claude-sessions-task-label' });
		label.createSpan({ cls: 'claude-sessions-task-id', text: `#${task.id}` });
		label.createSpan({ text: task.subject });
	}
}

function renderBashInput(block: ToolUseBlock, container: HTMLElement, ctx: RenderContext): void {
	const inputEl = container.createDiv({ cls: 'claude-sessions-tool-input' });
	inputEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'INPUT' });
	const command = String(block.input['command'] || '');
	const md = fence(command, 'bash');
	const mdContainer = inputEl.createDiv({ cls: 'claude-sessions-tool-input-code' });
	MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
}

function renderMarkdownToggle(content: string, lang: string, container: HTMLElement, ctx: RenderContext): void {
	const wrapper = container.createDiv({ cls: 'claude-sessions-read-result claude-sessions-read-md-toggle' });

	const toggleRow = wrapper.createDiv({ cls: 'claude-sessions-read-md-toggle-row' });
	const codeBtn = toggleRow.createEl('button', {
		cls: 'claude-sessions-read-md-btn clickable-icon is-active',
		attr: { 'aria-label': 'Show raw code', 'aria-pressed': 'true' },
	});
	setIcon(codeBtn, 'code');
	const previewBtn = toggleRow.createEl('button', {
		cls: 'claude-sessions-read-md-btn clickable-icon',
		attr: { 'aria-label': 'Show rendered Markdown', 'aria-pressed': 'false' },
	});
	setIcon(previewBtn, 'eye');

	const codeView = wrapper.createDiv({ cls: 'claude-sessions-read-md-code' });
	const codeMd = fence(content, lang);
	MarkdownRenderer.render(ctx.app, codeMd, codeView, '', ctx.component);

	const previewView = wrapper.createDiv({ cls: 'claude-sessions-read-md-preview claude-sessions-read-md-hidden' });
	MarkdownRenderer.render(ctx.app, content, previewView, '', ctx.component);

	const setActive = (mode: 'code' | 'preview') => {
		const isCode = mode === 'code';
		codeBtn.toggleClass('is-active', isCode);
		previewBtn.toggleClass('is-active', !isCode);
		codeBtn.setAttribute('aria-pressed', String(isCode));
		previewBtn.setAttribute('aria-pressed', String(!isCode));
		codeView.toggleClass('claude-sessions-read-md-hidden', !isCode);
		previewView.toggleClass('claude-sessions-read-md-hidden', isCode);
	};

	codeBtn.addEventListener('click', () => setActive('code'));
	previewBtn.addEventListener('click', () => setActive('preview'));
}

function renderSubAgentSession(
	session: SubAgentSession,
	container: HTMLElement,
	result: ToolResultBlock | undefined,
	ctx: RenderContext,
	delegate: ToolRendererDelegate,
): void {
	const timeline = container.createDiv({ cls: 'claude-sessions-subagent-timeline' });

	// Header with prompt (collapsible)
	const promptSection = timeline.createDiv({ cls: 'claude-sessions-subagent-prompt' });
	const promptHeader = promptSection.createDiv({ cls: 'claude-sessions-subagent-prompt-header' });
	promptHeader.createSpan({ cls: 'claude-sessions-subagent-prompt-chevron', text: '\u25B6' });
	promptHeader.createSpan({ cls: 'claude-sessions-tool-section-label', text: 'PROMPT' });
	const promptBody = promptSection.createDiv({ cls: 'claude-sessions-subagent-prompt-body' });
	delegate.renderTextContent(session.prompt, promptBody, 'claude-sessions-user-text');
	makeClickable(promptHeader, { label: 'Toggle sub-agent prompt', expanded: false });
	promptHeader.addEventListener('click', () => {
		const willOpen = !promptSection.hasClass('open');
		promptSection.toggleClass('open', willOpen);
		promptHeader.setAttribute('aria-expanded', String(willOpen));
	});

	// Flatten all assistant blocks across turns and force tool grouping
	const allBlocks: ContentBlock[] = [];
	for (const turn of session.turns) {
		if (turn.role === 'user') continue;
		for (const block of turn.contentBlocks) {
			allBlocks.push(block);
		}
	}
	if (allBlocks.length > 0) {
		const turnEl = timeline.createDiv({ cls: 'claude-sessions-subagent-turn' });
		delegate.renderAssistantBlocks(allBlocks, turnEl, 0, 0);
	}

	// Render agent output
	if (result && ctx.settings.showToolResults) {
		const outputEl = timeline.createDiv({ cls: 'claude-sessions-subagent-output' });
		const outputLabel = outputEl.createDiv({ cls: 'claude-sessions-tool-section-label' });
		outputLabel.createSpan({ text: 'OUTPUT' });
		addCopyButton(outputLabel, result.content, 'Copy output');
		const lines = result.content.split('\n').length;
		if (lines > COLLAPSE_THRESHOLD) {
			const wrapEl = outputEl.createDiv({ cls: 'claude-sessions-collapsible-wrap is-collapsed' });
			const contentEl = wrapEl.createDiv({ cls: 'claude-sessions-collapsible-content' });
			const bodyEl = contentEl.createDiv({ cls: 'claude-sessions-subagent-output-body' });
			MarkdownRenderer.render(ctx.app, result.content, bodyEl, '', ctx.component);
			wrapEl.createDiv({ cls: 'claude-sessions-collapsible-fade' });
			const toggleBtn = wrapEl.createEl('button', {
				cls: 'claude-sessions-collapsible-toggle',
				text: `Show more (${lines} lines)`,
				attr: { 'aria-expanded': 'false' },
			});
			toggleBtn.addEventListener('click', () => {
				const collapsed = wrapEl.hasClass('is-collapsed');
				wrapEl.toggleClass('is-collapsed', !collapsed);
				toggleBtn.setText(collapsed ? 'Show less' : `Show more (${lines} lines)`);
				toggleBtn.setAttribute('aria-expanded', String(collapsed));
			});
		} else {
			const bodyEl = outputEl.createDiv({ cls: 'claude-sessions-subagent-output-body' });
			MarkdownRenderer.render(ctx.app, result.content, bodyEl, '', ctx.component);
		}
	}
}

function isBashDiffResult(block: ToolUseBlock, resultText: string): boolean {
	const command = String(block.input['command'] || '').toLowerCase();
	if (!/\bdiff\b/.test(command)) return false;
	return /^(diff\s|---\s|@@\s)/m.test(resultText);
}

function renderDiffView(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement, ctx: RenderContext): void {
	const diffEl = container.createDiv({ cls: 'claude-sessions-diff-view' });

	if (block.input['file_path']) {
		diffEl.createDiv({
			cls: 'claude-sessions-diff-file',
			text: String(block.input['file_path']) + (block.input['replace_all'] ? ' (replace all)' : ''),
		});
	}

	const oldStr = String(block.input['old_string'] || '');
	const newStr = String(block.input['new_string'] || '');

	const changes = diffLines(oldStr, newStr);
	const outputLines: string[] = [];
	for (const change of changes) {
		const lines = change.value.replace(/\n$/, '').split('\n');
		const prefix = change.added ? '+ ' : change.removed ? '- ' : '  ';
		for (const line of lines) {
			outputLines.push(prefix + line);
		}
	}

	const md = fence(outputLines.join('\n'), 'diff');
	const mdContainer = diffEl.createDiv({ cls: 'claude-sessions-diff-code' });
	MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);

	if (result?.isError) {
		renderErrorOutput(result, container, ctx);
	}
}

function renderWriteView(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement, ctx: RenderContext): void {
	const writeEl = container.createDiv({ cls: 'claude-sessions-tool-input' });

	const filePath = String(block.input['file_path'] || '');
	if (filePath) {
		writeEl.createDiv({ cls: 'claude-sessions-diff-file', text: filePath });
	}

	const content = String(block.input['content'] || '');
	const lang = langFromPath(filePath);
	const isMarkdownFile = /\.mdx?$/i.test(filePath);

	if (isMarkdownFile) {
		renderMarkdownToggle(content, lang, writeEl, ctx);
	} else {
		const md = fence(content, lang);
		const mdContainer = writeEl.createDiv({ cls: 'claude-sessions-tool-input-code' });
		MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
	}

	if (result?.isError) {
		renderErrorOutput(result, container, ctx);
	}
}

/** Render a tool error as an OUTPUT section with error styling. */
function renderErrorOutput(result: ToolResultBlock, container: HTMLElement, ctx: RenderContext): void {
	const el = container.createDiv({
		cls: 'claude-sessions-tool-result claude-sessions-tool-result-error',
	});
	el.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'OUTPUT' });
	const md = fence(result.content);
	const mdContainer = el.createDiv({ cls: 'claude-sessions-tool-result-code' });
	MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
}

function toolPreview(block: ToolUseBlock): string {
	const input = block.input;
	const truncate = (s: string, max: number) =>
		s.length > max ? s.substring(0, max) + '...' : s;
	const baseName = (p: string) => p.split('/').pop() ?? p;

	switch (block.name) {
		case 'Edit': {
			const fp = String(input['file_path'] || '');
			if (!fp) return '';
			const name = baseName(fp);
			const old = input['old_string'] as string | undefined;
			const nw = input['new_string'] as string | undefined;
			if (old && nw) {
				const ol = old.split('\n').length;
				const nl = nw.split('\n').length;
				return ol === nl
					? `${name} \u2014 ${ol} line${ol > 1 ? 's' : ''}`
					: `${name} \u2014 ${ol} \u2192 ${nl} lines`;
			}
			return name;
		}
		case 'Write': {
			const fp = String(input['file_path'] || '');
			if (!fp) return '';
			const name = baseName(fp);
			const content = input['content'] as string | undefined;
			if (content) {
				return `${name} \u2014 ${content.split('\n').length} lines`;
			}
			return name;
		}
		case 'Read': {
			const fp = String(input['file_path'] || '');
			if (!fp) return '';
			const name = baseName(fp);
			const limit = input['limit'] as number | undefined;
			const offset = input['offset'] as number | undefined;
			if (limit) {
				const start = offset ?? 1;
				return `${name} \u2014 lines ${start}\u2013${start + limit - 1}`;
			}
			return name;
		}
		case 'Grep': {
			const pat = input['pattern'] as string | undefined;
			if (!pat) return '';
			const patStr = `"${truncate(pat, 30)}"`;
			const glob = input['glob'] as string | undefined;
			const path = input['path'] as string | undefined;
			if (glob) return `${patStr} in ${glob}`;
			if (path) return `${patStr} in ${baseName(path)}`;
			return patStr;
		}
		case 'Glob': {
			const pat = input['pattern'] as string | undefined;
			if (!pat) return '';
			const patStr = `"${truncate(pat, 30)}"`;
			const path = input['path'] as string | undefined;
			if (path) return `${patStr} in ${baseName(path)}`;
			return patStr;
		}
		case 'Bash': {
			const desc = input['description'] as string | undefined;
			if (desc) return truncate(desc, 50);
			return truncate(String(input['command'] || ''), 50);
		}
		case 'Agent':
		case 'Task': {
			const desc = String(input['description'] || '');
			const subType = input['subagent_type'] as string | undefined;
			const prefix = subType ? `${subType} \u2014 ` : '';
			if (desc) return `${prefix}${truncate(desc, 40)}`;
			return subType ?? '';
		}
		case 'WebFetch': {
			const url = input['url'] as string | undefined;
			if (url) {
				try {
					const u = new URL(url);
					return truncate(u.hostname + u.pathname, 50);
				} catch {
					return truncate(url, 50);
				}
			}
			return '';
		}
		case 'WebSearch': {
			const query = input['query'] as string | undefined;
			return query ? `"${truncate(query, 40)}"` : '';
		}
		default: {
			if (Object.keys(input).length === 0) return '';
			const nameField = input['name'] ?? input['path'] ?? input['file'] ?? input['query'] ?? input['command'];
			if (typeof nameField === 'string') return truncate(nameField, 50);
			return compactInputPreview(input, 55);
		}
	}
}

function formatToolDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const min = Math.floor(sec / 60);
	const remSec = Math.round(sec % 60);
	return `${min}m ${remSec}s`;
}

function formatInput(input: Record<string, unknown>): string {
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

/** Parse MCP tool names like `mcp__server-name__tool_name` into parts. */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith('mcp__')) return null;
	const rest = name.slice(5); // strip "mcp__"
	const sep = rest.indexOf('__');
	if (sep < 0) return null;
	return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** Format input as compact key=value pairs for header preview. */
function compactInputPreview(input: Record<string, unknown>, max: number): string {
	const parts: string[] = [];
	let len = 0;
	for (const [k, v] of Object.entries(input)) {
		const val = typeof v === 'string' ? v : JSON.stringify(v);
		const part = `${k}=${val}`;
		if (len + part.length > max && parts.length > 0) {
			parts.push('...');
			break;
		}
		parts.push(part);
		len += part.length + 1;
	}
	return parts.join(' ');
}
