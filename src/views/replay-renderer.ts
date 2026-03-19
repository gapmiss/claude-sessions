import { App, MarkdownRenderer, Component } from 'obsidian';
import {
	Turn, ContentBlock, ToolUseBlock, ToolResultBlock, PluginSettings,
} from '../types';

const COLLAPSE_THRESHOLD = 10; // lines before "Show more"
const TOOL_GROUP_THRESHOLD = 4; // consecutive tools before grouping

function formatElapsed(ms: number): string {
	if (ms <= 0) return '0:00';
	const totalSec = Math.round(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}

export class ReplayRenderer {
	private container: HTMLElement;
	private app: App;
	private component: Component;
	private settings: PluginSettings;
	private turnEls: HTMLElement[] = [];
	private sessionStartMs = 0;

	constructor(container: HTMLElement, app: App, component: Component, settings: PluginSettings) {
		this.container = container;
		this.app = app;
		this.component = component;
		this.settings = settings;
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	getTurnElements(): HTMLElement[] {
		return this.turnEls;
	}

	/**
	 * Render the full timeline of all turns into the container.
	 * @param sessionStartMs - session start time in epoch ms for elapsed time display (0 = use wall-clock)
	 * Returns the array of turn DOM elements.
	 */
	renderTimeline(turns: Turn[], sessionStartMs = 0): HTMLElement[] {
		this.container.empty();
		this.turnEls = [];
		this.sessionStartMs = sessionStartMs;

		for (const turn of turns) {
			const el = this.renderTurn(turn);
			this.container.appendChild(el);
			this.turnEls.push(el);
		}

		return this.turnEls;
	}

	/**
	 * Get all block wrapper elements within a specific turn element.
	 */
	getBlockWrappers(turnIndex: number): HTMLElement[] {
		const turnEl = this.turnEls[turnIndex];
		if (!turnEl) return [];
		return Array.from(turnEl.querySelectorAll('.agent-sessions-block-wrapper')) as HTMLElement[];
	}

	/**
	 * Render a single turn as a self-contained DOM element.
	 */
	private renderTurn(turn: Turn): HTMLElement {
		const turnEl = this.container.createDiv({
			cls: 'agent-sessions-turn',
			attr: { 'data-turn-index': String(turn.index) },
		});

		// Turn header (collapsible)
		const header = turnEl.createDiv({ cls: 'agent-sessions-turn-header' });
		const chevron = header.createSpan({ cls: 'agent-sessions-turn-chevron', text: '\u25BC' });
		header.createSpan({ cls: 'agent-sessions-turn-label', text: `#${turn.index + 1}` });

		if (turn.timestamp) {
			if (this.sessionStartMs > 0) {
				// Show elapsed time from session start
				const elapsed = new Date(turn.timestamp).getTime() - this.sessionStartMs;
				if (!isNaN(elapsed)) {
					header.createSpan({ cls: 'agent-sessions-turn-ts', text: formatElapsed(elapsed) });
				}
			} else {
				// Fallback: wall-clock HH:MM
				const d = new Date(turn.timestamp);
				const h = d.getHours();
				const m = String(d.getMinutes()).padStart(2, '0');
				header.createSpan({ cls: 'agent-sessions-turn-ts', text: `${h}:${m}` });
			}
		}

		header.addEventListener('click', () => {
			turnEl.toggleClass('collapsed', !turnEl.hasClass('collapsed'));
			chevron.setText(turnEl.hasClass('collapsed') ? '\u25B6' : '\u25BC');
		});

		// Turn body
		const body = turnEl.createDiv({ cls: 'agent-sessions-turn-body' });

		// Separate user and assistant blocks
		const userBlocks = turn.role === 'user' ? turn.contentBlocks : [];
		const assistantBlocks = turn.role === 'assistant' ? turn.contentBlocks : [];

		// User section
		let blockIdx = 0;
		if (userBlocks.length > 0) {
			const userSection = body.createDiv({ cls: 'agent-sessions-role-section agent-sessions-role-user' });
			userSection.createDiv({ cls: 'agent-sessions-role-label agent-sessions-role-user-label', text: 'USER' });

			for (const block of userBlocks) {
				if (block.type === 'text') {
					const wrapper = userSection.createDiv({
						cls: 'agent-sessions-block-wrapper',
						attr: { 'data-block-idx': String(blockIdx++) },
					});
					this.renderTextContent(block.text, wrapper, 'agent-sessions-user-text');
				}
			}
		}

		// Assistant section
		if (assistantBlocks.length > 0) {
			const assistantSection = body.createDiv({ cls: 'agent-sessions-role-section agent-sessions-role-assistant' });
			assistantSection.createDiv({ cls: 'agent-sessions-role-label agent-sessions-role-assistant-label', text: 'CLAUDE' });

			this.renderAssistantBlocks(assistantBlocks, assistantSection, blockIdx);
		}

		return turnEl;
	}

	private renderAssistantBlocks(blocks: ContentBlock[], container: HTMLElement, startBlockIdx = 0): void {
		// Group consecutive tool_use and tool_result blocks into runs
		const segments: Array<{ type: 'single'; block: ContentBlock } | { type: 'tools'; blocks: ContentBlock[] }> = [];
		let toolRun: ContentBlock[] = [];

		const flushTools = () => {
			if (toolRun.length > 0) {
				segments.push({ type: 'tools', blocks: [...toolRun] });
				toolRun = [];
			}
		};

		for (const block of blocks) {
			if (block.type === 'tool_use' || block.type === 'tool_result') {
				toolRun.push(block);
			} else {
				flushTools();
				segments.push({ type: 'single', block });
			}
		}
		flushTools();

		let blockIdx = startBlockIdx;
		for (const seg of segments) {
			const wrapper = container.createDiv({
				cls: 'agent-sessions-block-wrapper',
				attr: { 'data-block-idx': String(blockIdx++) },
			});
			if (seg.type === 'single') {
				this.renderSingleBlock(seg.block, wrapper);
			} else {
				this.renderToolGroup(seg.blocks, wrapper);
			}
		}
	}

	private renderSingleBlock(block: ContentBlock, container: HTMLElement): void {
		switch (block.type) {
			case 'text':
				this.renderTextContent(block.text, container, 'agent-sessions-assistant-text');
				break;
			case 'thinking':
				if (this.settings.showThinkingBlocks) {
					this.renderThinkingBlock(block.thinking, container);
				}
				break;
		}
	}

	private renderToolGroup(blocks: ContentBlock[], container: HTMLElement): void {
		const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
		const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');

		// Build result map for matching
		const resultMap = new Map<string, ToolResultBlock>();
		for (const r of toolResults) {
			resultMap.set(r.toolUseId, r);
		}

		if (!this.settings.showToolCalls) return;

		if (toolUses.length <= TOOL_GROUP_THRESHOLD) {
			// Render individually
			for (const tu of toolUses) {
				this.renderToolCall(tu, resultMap.get(tu.id), container);
			}
		} else {
			// Group them
			const groupEl = container.createDiv({ cls: 'agent-sessions-tool-group' });
			const groupHeader = groupEl.createDiv({ cls: 'agent-sessions-tool-group-header' });
			const groupChevron = groupHeader.createSpan({ cls: 'agent-sessions-tool-group-chevron', text: '\u25B6' });

			const uniqueNames = [...new Set(toolUses.map(t => t.name))].join(', ');
			const hasError = toolResults.some(r => r.isError);
			if (hasError) {
				groupHeader.createSpan({ cls: 'agent-sessions-tool-indicator agent-sessions-tool-error' });
			}
			groupHeader.createSpan({ text: `${toolUses.length} tool calls ` });
			groupHeader.createSpan({ cls: 'agent-sessions-tool-group-names', text: uniqueNames });
			groupHeader.createSpan({ cls: 'agent-sessions-block-spinner' });

			const groupBody = groupEl.createDiv({ cls: 'agent-sessions-tool-group-body' });

			groupHeader.addEventListener('click', () => {
				const isOpen = groupEl.hasClass('open');
				groupEl.toggleClass('open', !isOpen);
				groupChevron.setText(isOpen ? '\u25B6' : '\u25BC');
			});

			for (const tu of toolUses) {
				this.renderToolCall(tu, resultMap.get(tu.id), groupBody);
			}
		}
	}

	private renderToolCall(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement): void {
		const toolEl = container.createDiv({ cls: 'agent-sessions-tool-block' });

		// Header bar
		const header = toolEl.createDiv({ cls: 'agent-sessions-tool-header' });
		const isError = result?.isError ?? false;
		header.createSpan({
			cls: `agent-sessions-tool-indicator ${isError ? 'agent-sessions-tool-error' : ''}`,
		});
		header.createSpan({ cls: 'agent-sessions-tool-name', text: block.name });
		header.createSpan({ cls: 'agent-sessions-tool-preview', text: this.toolPreview(block) });
		header.createSpan({ cls: 'agent-sessions-block-spinner' });
		const chevron = header.createSpan({ cls: 'agent-sessions-tool-chevron', text: '\u25B6' });

		// Body (hidden by default)
		const body = toolEl.createDiv({ cls: 'agent-sessions-tool-body' });

		// Input section
		if (block.name === 'Edit' && block.input['old_string'] != null) {
			this.renderDiffView(block, result, body);
		} else {
			const inputEl = body.createDiv({ cls: 'agent-sessions-tool-input' });
			inputEl.createDiv({ cls: 'agent-sessions-tool-section-label', text: 'INPUT' });
			const inputText = this.formatInput(block.input);
			inputEl.createEl('pre').createEl('code', { text: inputText });
		}

		// Result section
		if (result && this.settings.showToolResults) {
			const resultEl = body.createDiv({
				cls: `agent-sessions-tool-result ${isError ? 'agent-sessions-tool-result-error' : ''}`,
			});
			resultEl.createDiv({ cls: 'agent-sessions-tool-section-label', text: 'RESULT' });
			const resultText = result.content.length > 5000
				? result.content.substring(0, 5000) + '\n... (truncated)'
				: result.content;
			resultEl.createEl('pre').createEl('code', { text: resultText });
		}

		header.addEventListener('click', () => {
			const isOpen = toolEl.hasClass('open');
			toolEl.toggleClass('open', !isOpen);
			chevron.setText(isOpen ? '\u25B6' : '\u25BC');
		});
	}

	private renderDiffView(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement): void {
		const diffEl = container.createDiv({ cls: 'agent-sessions-diff-view' });

		if (block.input['file_path']) {
			diffEl.createDiv({
				cls: 'agent-sessions-diff-file',
				text: String(block.input['file_path']) + (block.input['replace_all'] ? ' (replace all)' : ''),
			});
		}

		const oldStr = String(block.input['old_string'] || '');
		const newStr = String(block.input['new_string'] || '');

		for (const line of oldStr.split('\n')) {
			diffEl.createDiv({ cls: 'agent-sessions-diff-del', text: '\u2212 ' + line });
		}
		for (const line of newStr.split('\n')) {
			diffEl.createDiv({ cls: 'agent-sessions-diff-add', text: '+ ' + line });
		}

		if (result) {
			diffEl.createDiv({
				cls: `agent-sessions-diff-result ${result.isError ? 'agent-sessions-diff-result-error' : ''}`,
				text: result.content,
			});
		}
	}

	private renderThinkingBlock(text: string, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'agent-sessions-thinking-block' });
		const header = el.createDiv({ cls: 'agent-sessions-thinking-header' });
		const chevron = header.createSpan({ cls: 'agent-sessions-thinking-chevron', text: '\u25B6' });
		header.createSpan({ text: ' Thinking' });
		header.createSpan({ cls: 'agent-sessions-block-spinner' });

		const body = el.createDiv({ cls: 'agent-sessions-thinking-body' });
		MarkdownRenderer.render(this.app, text, body, '', this.component);

		header.addEventListener('click', () => {
			const isOpen = el.hasClass('open');
			el.toggleClass('open', !isOpen);
			chevron.setText(isOpen ? '\u25BC' : '\u25B6');
		});
	}

	private renderTextContent(text: string, container: HTMLElement, cls: string): void {
		const lines = text.split('\n').length;
		const wrapEl = container.createDiv();

		if (lines > COLLAPSE_THRESHOLD) {
			// Collapsible wrapper
			wrapEl.addClass('agent-sessions-collapsible-wrap', 'is-collapsed');
			const contentEl = wrapEl.createDiv({ cls: 'agent-sessions-collapsible-content' });
			const mdEl = contentEl.createDiv({ cls });
			MarkdownRenderer.render(this.app, text, mdEl, '', this.component);

			wrapEl.createDiv({ cls: 'agent-sessions-collapsible-fade' });
			const toggleBtn = wrapEl.createEl('button', {
				cls: 'agent-sessions-collapsible-toggle',
				text: `Show more (${lines} lines)`,
			});
			toggleBtn.addEventListener('click', () => {
				const collapsed = wrapEl.hasClass('is-collapsed');
				wrapEl.toggleClass('is-collapsed', !collapsed);
				toggleBtn.setText(collapsed ? 'Show less' : `Show more (${lines} lines)`);
			});
		} else {
			const mdEl = wrapEl.createDiv({ cls });
			MarkdownRenderer.render(this.app, text, mdEl, '', this.component);
		}
	}

	private toolPreview(block: ToolUseBlock): string {
		const input = block.input;
		switch (block.name) {
			case 'Edit':
			case 'Write':
			case 'Read':
				return String(input['file_path'] || '');
			case 'Grep':
			case 'Glob':
				return (input['pattern'] || '') + (input['path'] ? ' in ' + input['path'] : '');
			case 'Bash':
				return String(input['command'] || '');
			default: {
				const s = JSON.stringify(input);
				return s.length > 60 ? s.substring(0, 60) + '...' : s;
			}
		}
	}

	private formatInput(input: Record<string, unknown>): string {
		try {
			return JSON.stringify(input, null, 2);
		} catch {
			return String(input);
		}
	}
}
