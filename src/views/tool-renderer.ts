import { MarkdownRenderer, setIcon } from 'obsidian';
import { diffLines } from 'diff';
import type { ContentBlock, ToolUseBlock, ToolResultBlock, ToolResultImage, SubAgentSession } from '../types';
import { TASK_TOOL_NAMES, ANSI_RE } from '../constants';
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

	// Hook indicator (inline PreToolUse events)
	const hookEvents = ctx.hookEventsByToolId?.get(block.id);
	if (hookEvents && hookEvents.length > 0) {
		const hookIndicator = header.createSpan({ cls: 'claude-sessions-tool-hook-indicator' });
		setIcon(hookIndicator, 'zap');
		// Build tooltip content
		const tooltipLines = hookEvents.map(h => {
			const parts: string[] = [h.hookEvent];
			if (h.durationMs > 0) parts.push(`${h.durationMs}ms`);
			return parts.join(' · ');
		});
		hookIndicator.setAttribute('aria-label', tooltipLines.join('\n'));
		hookIndicator.setAttribute('data-tooltip-position', 'top');
	}

	header.createSpan({ cls: 'claude-sessions-tool-chevron', text: '\u25B6' });

	// Body (hidden by default)
	const body = toolEl.createDiv({ cls: 'claude-sessions-tool-body' });

	// Input section
	if (block.name === 'AskUserQuestion') {
		renderAskUserQuestion(block, result, body, ctx);
	} else if ((block.name === 'Agent' || block.name === 'Task') && block.subAgentSession) {
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
		void MarkdownRenderer.render(ctx.app, inputMd, inputMdContainer, '', ctx.component);
	}

	// Result section (skip for Edit/Write/Agent/AskUserQuestion which render their own results)
	if (result && ctx.settings.showToolResults
		&& block.name !== 'AskUserQuestion'
		&& !(block.name === 'Edit' && block.input['old_string'] != null)
		&& !(block.name === 'Write' && block.input['content'] != null)
		&& !((block.name === 'Agent' || block.name === 'Task') && block.subAgentSession)) {
		renderToolResult(block, result, isError, body, ctx, delegate);
	}

	// Hook details section (inline PreToolUse events)
	if (hookEvents && hookEvents.length > 0) {
		const hookSection = body.createDiv({ cls: 'claude-sessions-tool-hook-section' });
		hookSection.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'HOOKS' });
		for (const hook of hookEvents) {
			const hookEl = hookSection.createDiv({ cls: 'claude-sessions-tool-hook-item' });
			// Header line: event type, duration, command
			const hookHeader = hookEl.createDiv({ cls: 'claude-sessions-tool-hook-header' });
			hookHeader.createSpan({ cls: 'claude-sessions-tool-hook-event', text: hook.hookEvent });
			if (hook.durationMs > 0) {
				hookHeader.createSpan({ cls: 'claude-sessions-tool-hook-duration', text: `${hook.durationMs}ms` });
			}
			if (hook.command) {
				const cmdName = hook.command.split('/').pop() ?? hook.command;
				hookHeader.createSpan({ cls: 'claude-sessions-tool-hook-command', text: cmdName });
			}
			// Stdout content (if any)
			if (hook.stdout && hook.stdout.trim()) {
				const stdoutEl = hookEl.createDiv({ cls: 'claude-sessions-tool-hook-stdout' });
				// Try to parse as JSON for pretty display
				try {
					const parsed: unknown = JSON.parse(hook.stdout);
					const formatted = JSON.stringify(parsed, null, 2);
					const codeEl = stdoutEl.createEl('pre');
					codeEl.createEl('code', { text: formatted });
				} catch {
					stdoutEl.createEl('pre').createEl('code', { text: hook.stdout.trim() });
				}
			}
		}
	}

	makeClickable(header, { label: `Toggle ${block.name} details`, expanded: false });
	header.addEventListener('click', () => {
		const willOpen = !toolEl.hasClass('open');
		toolEl.toggleClass('open', willOpen);
		header.setAttribute('aria-expanded', String(willOpen));
	});
}

function hasAnsiCodes(text: string): boolean {
	return ANSI_RE.test(text);
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
	} else if (block.name === 'ToolSearch' && !isError && result.enrichedResult) {
		renderToolSearchResult(result.enrichedResult, resultEl);
	} else if (result.images && result.images.length > 0) {
		renderToolResultImages(result.images, resultEl, delegate);
		if (resultText) {
			const md = fence(resultText);
			const mdContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code' });
			void MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
		}
	} else if (block.name === 'Read' && !isError) {
		const filePath = typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '';
		const lang = langFromPath(filePath);
		const cleaned = stripLineNumbers(resultText);
		const isMarkdownFile = /\.mdx?$/i.test(filePath);

		if (isMarkdownFile) {
			renderMarkdownToggle(cleaned, lang, resultEl, ctx);
		} else {
			const md = fence(cleaned, lang);
			const mdContainer = resultEl.createDiv({ cls: 'claude-sessions-read-result' });
			void MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
		}
	} else if (block.name === 'Bash' && !isError && isBashDiffResult(block, resultText)) {
		const resultMd = fence(resultText, 'diff');
		const resultMdContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code' });
		void MarkdownRenderer.render(ctx.app, resultMd, resultMdContainer, '', ctx.component);
	} else if (block.name === 'Bash' && !isError && hasAnsiCodes(resultText)) {
		const pre = resultEl.createEl('pre', { cls: 'claude-sessions-ansi-block' });
		delegate.buildAnsiDom(resultText, pre);
	} else {
		const resultMd = fence(resultText);
		const resultMdContainer = resultEl.createDiv({ cls: 'claude-sessions-tool-result-code' });
		void MarkdownRenderer.render(ctx.app, resultMd, resultMdContainer, '', ctx.component);
	}

	// Show enriched data (Bash exit code + stderr)
	if (block.name === 'Bash' && result.enrichedResult) {
		const exitCode = typeof result.enrichedResult['exitCode'] === 'number' ? result.enrichedResult['exitCode'] : undefined;
		const stderr = typeof result.enrichedResult['stderr'] === 'string' ? result.enrichedResult['stderr'] : undefined;
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
			void MarkdownRenderer.render(ctx.app, stderrMd, stderrContainer, '', ctx.component);
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
		const id = typeof t['id'] === 'string' ? t['id'] : '';
		ts.set(id, { id, subject: typeof t['subject'] === 'string' ? t['subject'] : '', status: 'pending' });
	} else if (block.name === 'TaskUpdate' && enriched['taskId']) {
		const id = typeof enriched['taskId'] === 'string' ? enriched['taskId'] : '';
		const existing = ts.get(id);
		const sc = enriched['statusChange'] as Record<string, string> | undefined;
		const status = (sc?.['to'] || existing?.status || 'pending') as TaskState['status'];
		ts.set(id, { id, subject: existing?.subject || '', status });
	} else if (block.name === 'TaskList' && Array.isArray(enriched['tasks'])) {
		ts.clear();
		for (const t of enriched['tasks'] as Record<string, unknown>[]) {
			const id = typeof t['id'] === 'string' ? t['id'] : '';
			ts.set(id, {
				id,
				subject: typeof t['subject'] === 'string' ? t['subject'] : '',
				status: (typeof t['status'] === 'string' ? t['status'] : 'pending') as TaskState['status'],
			});
		}
	} else if (block.name === 'TaskGet' && enriched['id']) {
		const id = typeof enriched['id'] === 'string' ? enriched['id'] : '';
		const existing = ts.get(id);
		ts.set(id, {
			id,
			subject: typeof enriched['subject'] === 'string' ? enriched['subject'] : (existing?.subject || ''),
			status: (typeof enriched['status'] === 'string' ? enriched['status'] : (existing?.status || 'pending')) as TaskState['status'],
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

// ── AskUserQuestion rendering ─────────────────────────────────

// ── ToolSearch rendering ──────────────────────────────────────

function renderToolSearchResult(
	enriched: Record<string, unknown>,
	container: HTMLElement,
): void {
	const matches = Array.isArray(enriched['matches']) ? enriched['matches'] as string[] : [];
	const total = typeof enriched['total_deferred_tools'] === 'number' ? enriched['total_deferred_tools'] : undefined;

	if (matches.length === 0) {
		container.createDiv({ cls: 'claude-sessions-toolsearch-empty', text: 'No matching tools found' });
		return;
	}

	const list = container.createDiv({ cls: 'claude-sessions-toolsearch-matches' });
	for (const name of matches) {
		const item = list.createDiv({ cls: 'claude-sessions-toolsearch-match' });
		const icon = item.createSpan({ cls: 'claude-sessions-toolsearch-icon' });
		setIcon(icon, 'wrench');
		item.createSpan({ text: name });
	}

	if (total != null) {
		container.createDiv({
			cls: 'claude-sessions-toolsearch-total',
			text: `${matches.length} of ${total} deferred tools matched`,
		});
	}
}

// ── AskUserQuestion rendering ─────────────────────────────────

interface AskOption {
	label: string;
	description: string;
}

interface AskQuestion {
	header: string;
	question: string;
	options: AskOption[];
	multiSelect: boolean;
}

function renderAskUserQuestion(
	block: ToolUseBlock,
	result: ToolResultBlock | undefined,
	container: HTMLElement,
	_ctx: RenderContext,
): void {
	const questions = block.input['questions'] as AskQuestion[] | undefined;
	if (!questions?.length) return;

	const rawJson = formatInput(block.input);

	// Parse answers from result text
	const answers = new Map<string, string>();
	const isRejected = result?.isError ?? false;
	if (result && !isRejected) {
		// Result format: "question"="answer", "question"="answer"
		const answerMatches = result.content.matchAll(/"([^"]+)"="([^"]+)"/g);
		for (const m of answerMatches) {
			answers.set(m[1], m[2]);
		}
	}

	const wrapper = container.createDiv({ cls: 'claude-sessions-ask-user' });

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const questionEl = wrapper.createDiv({ cls: 'claude-sessions-ask-question' });

		// Header row with badge and copy button (on first question only)
		const headerRow = questionEl.createDiv({ cls: 'claude-sessions-ask-header-row' });
		if (q.header) {
			headerRow.createSpan({ cls: 'claude-sessions-ask-header', text: q.header });
		}
		if (i === 0) {
			addCopyButton(headerRow, rawJson, 'Copy raw JSON');
		}

		// Question text
		questionEl.createDiv({ cls: 'claude-sessions-ask-text', text: q.question });

		// Options list
		const optionsEl = questionEl.createDiv({ cls: 'claude-sessions-ask-options' });
		const answer = answers.get(q.question) ?? '';
		const selectedLabels = new Set(answer.split(', ').map(s => s.trim()).filter(Boolean));

		for (const opt of q.options) {
			const isSelected = selectedLabels.has(opt.label);
			const optEl = optionsEl.createDiv({
				cls: `claude-sessions-ask-option ${isSelected ? 'claude-sessions-ask-option-selected' : ''}`,
			});
			const labelRow = optEl.createDiv({ cls: 'claude-sessions-ask-option-label' });
			labelRow.createSpan({ text: opt.label });
			if (isSelected) {
				const check = labelRow.createSpan({ cls: 'claude-sessions-ask-option-check' });
				setIcon(check, 'check');
			}
			if (opt.description) {
				optEl.createDiv({ cls: 'claude-sessions-ask-option-desc', text: opt.description });
			}
		}
	}

	// Rejected state
	if (isRejected && result) {
		const rejectedEl = wrapper.createDiv({ cls: 'claude-sessions-ask-rejected' });
		rejectedEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'CLARIFICATION' });
		rejectedEl.createDiv({ cls: 'claude-sessions-ask-rejected-text', text: result.content });
	}

	// Answer summary (only for successful responses)
	if (answers.size > 0) {
		const answerEl = wrapper.createDiv({ cls: 'claude-sessions-ask-answers' });
		answerEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'USER ANSWERS' });
		for (const [question, answer] of answers) {
			const row = answerEl.createDiv({ cls: 'claude-sessions-ask-answer-row' });
			row.createSpan({ cls: 'claude-sessions-ask-answer-q', text: question + ' ' });
			row.createSpan({ cls: 'claude-sessions-ask-answer-a', text: answer });
		}
	}
}

function renderBashInput(block: ToolUseBlock, container: HTMLElement, ctx: RenderContext): void {
	const inputEl = container.createDiv({ cls: 'claude-sessions-tool-input' });
	inputEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'INPUT' });
	const command = typeof block.input['command'] === 'string' ? block.input['command'] : '';
	const md = fence(command, 'bash');
	const mdContainer = inputEl.createDiv({ cls: 'claude-sessions-tool-input-code' });
	void MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
}

function renderMarkdownToggle(content: string, lang: string, container: HTMLElement, ctx: RenderContext): void {
	const wrapper = container.createDiv({ cls: 'claude-sessions-read-result claude-sessions-read-md-toggle' });

	const toggleRow = wrapper.createDiv({ cls: 'claude-sessions-read-md-toggle-row' });
	const codeBtn = toggleRow.createEl('button', {
		cls: 'claude-sessions-read-md-btn clickable-icon is-active',
		attr: { 'aria-pressed': 'true' },
	});
	setIcon(codeBtn, 'code');
	makeClickable(codeBtn, { label: 'Show raw code' });
	const previewBtn = toggleRow.createEl('button', {
		cls: 'claude-sessions-read-md-btn clickable-icon',
		attr: { 'aria-pressed': 'false' },
	});
	setIcon(previewBtn, 'eye');
	makeClickable(previewBtn, { label: 'Show rendered Markdown' });

	const codeView = wrapper.createDiv({ cls: 'claude-sessions-read-md-code' });
	const codeMd = fence(content, lang);
	void MarkdownRenderer.render(ctx.app, codeMd, codeView, '', ctx.component);

	const previewView = wrapper.createDiv({ cls: 'claude-sessions-read-md-preview claude-sessions-read-md-hidden' });
	void MarkdownRenderer.render(ctx.app, content, previewView, '', ctx.component);

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
			void MarkdownRenderer.render(ctx.app, result.content, bodyEl, '', ctx.component);
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
			void MarkdownRenderer.render(ctx.app, result.content, bodyEl, '', ctx.component);
		}
	}
}

function isBashDiffResult(block: ToolUseBlock, resultText: string): boolean {
	const command = (typeof block.input['command'] === 'string' ? block.input['command'] : '').toLowerCase();
	if (!/\bdiff\b/.test(command)) return false;
	return /^(diff\s|---\s|@@\s)/m.test(resultText);
}

function renderDiffView(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement, ctx: RenderContext): void {
	const diffEl = container.createDiv({ cls: 'claude-sessions-diff-view' });

	if (block.input['file_path']) {
		diffEl.createDiv({
			cls: 'claude-sessions-diff-file',
			text: (typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '') + (block.input['replace_all'] ? ' (replace all)' : ''),
		});
	}

	const oldStr = typeof block.input['old_string'] === 'string' ? block.input['old_string'] : '';
	const newStr = typeof block.input['new_string'] === 'string' ? block.input['new_string'] : '';

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
	void MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);

	if (result?.isError) {
		renderErrorOutput(result, container, ctx);
	}
}

function renderWriteView(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement, ctx: RenderContext): void {
	const writeEl = container.createDiv({ cls: 'claude-sessions-tool-input' });

	const filePath = typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '';
	if (filePath) {
		writeEl.createDiv({ cls: 'claude-sessions-diff-file', text: filePath });
	}

	const content = typeof block.input['content'] === 'string' ? block.input['content'] : '';
	const lang = langFromPath(filePath);
	const isMarkdownFile = /\.mdx?$/i.test(filePath);

	if (isMarkdownFile) {
		renderMarkdownToggle(content, lang, writeEl, ctx);
	} else {
		const md = fence(content, lang);
		const mdContainer = writeEl.createDiv({ cls: 'claude-sessions-tool-input-code' });
		void MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
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
	void MarkdownRenderer.render(ctx.app, md, mdContainer, '', ctx.component);
}

function toolPreview(block: ToolUseBlock): string {
	const input = block.input;
	const truncate = (s: string, max: number) =>
		s.length > max ? s.substring(0, max) + '...' : s;
	const baseName = (p: string) => p.split('/').pop() ?? p;

	switch (block.name) {
		case 'Edit': {
			const fp = typeof input['file_path'] === 'string' ? input['file_path'] : '';
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
			const fp = typeof input['file_path'] === 'string' ? input['file_path'] : '';
			if (!fp) return '';
			const name = baseName(fp);
			const content = input['content'] as string | undefined;
			if (content) {
				return `${name} \u2014 ${content.split('\n').length} lines`;
			}
			return name;
		}
		case 'Read': {
			const fp = typeof input['file_path'] === 'string' ? input['file_path'] : '';
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
			return truncate(typeof input['command'] === 'string' ? input['command'] : '', 50);
		}
		case 'AskUserQuestion': {
			const qs = input['questions'] as Array<Record<string, unknown>> | undefined;
			if (!qs?.length) return '';
			const first = qs[0];
			const q = typeof first['question'] === 'string' ? first['question'] : '';
			const prefix = qs.length > 1 ? `${qs.length} questions \u2014 ` : '';
			return `${prefix}${truncate(q, 40)}`;
		}
		case 'Agent':
		case 'Task': {
			const desc = typeof input['description'] === 'string' ? input['description'] : '';
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
		return JSON.stringify(input);
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
