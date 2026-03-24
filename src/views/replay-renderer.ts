import { App, Modal, MarkdownRenderer, Component, setIcon } from 'obsidian';
import type {
	Turn, ContentBlock, AnsiBlock, CompactionBlock,
	PluginSettings, Session,
} from '../types';
import {
	type RenderContext, COLLAPSE_THRESHOLD,
	makeClickable, formatElapsed,
} from './render-helpers';
import { renderSummary } from './summary-renderer';
import { renderToolGroup, type ToolRendererDelegate } from './tool-renderer';

const SAFE_IMAGE_TYPES = new Set([
	'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff',
]);

export class ReplayRenderer {
	private container: HTMLElement;
	private ctx: RenderContext;
	private turnEls: HTMLElement[] = [];
	private sessionStartMs = 0;
	private sessionModel?: string;
	private delegate: ToolRendererDelegate;

	constructor(container: HTMLElement, app: App, component: Component, settings: PluginSettings) {
		this.container = container;
		this.ctx = { app, component, settings };
		this.delegate = {
			renderAssistantBlocks: this.renderAssistantBlocks.bind(this),
			renderTextContent: this.renderTextContent.bind(this),
		};
	}

	updateSettings(settings: PluginSettings): void {
		this.ctx.settings = settings;
	}

	getTurnElements(): HTMLElement[] {
		return this.turnEls;
	}

	/**
	 * Render the full timeline of all turns into the container.
	 * Returns the array of turn DOM elements.
	 */
	renderTimeline(turns: Turn[], sessionStartMs = 0, session?: Session): HTMLElement[] {
		this.container.empty();
		this.turnEls = [];
		this.sessionStartMs = sessionStartMs;
		this.sessionModel = session?.metadata.model;

		if (session) {
			renderSummary(session, this.container, this.ctx);
		}

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

	private renderTurn(turn: Turn): HTMLElement {
		const turnEl = this.container.createDiv({
			cls: 'agent-sessions-turn',
			attr: { 'data-turn-index': String(turn.index) },
		});

		// Turn header (collapsible)
		const header = turnEl.createDiv({ cls: 'agent-sessions-turn-header' });
		header.createSpan({ cls: 'agent-sessions-turn-chevron', text: '\u25B6' });
		header.createSpan({ cls: 'agent-sessions-turn-label', text: `#${turn.index + 1}` });

		if (turn.timestamp) {
			if (this.sessionStartMs > 0) {
				const elapsed = new Date(turn.timestamp).getTime() - this.sessionStartMs;
				if (!isNaN(elapsed)) {
					header.createSpan({ cls: 'agent-sessions-turn-ts', text: formatElapsed(elapsed) });
				}
			} else {
				const d = new Date(turn.timestamp);
				const h = d.getHours();
				const m = String(d.getMinutes()).padStart(2, '0');
				header.createSpan({ cls: 'agent-sessions-turn-ts', text: `${h}:${m}` });
			}
		}

		if (turn.model && turn.model !== this.sessionModel) {
			header.createSpan({ cls: 'agent-sessions-turn-model', text: turn.model });
		}
		if (turn.stopReason === 'max_tokens') {
			header.createSpan({
				cls: 'agent-sessions-turn-stop-reason',
				attr: { 'aria-label': 'Response truncated (max tokens)', 'data-tooltip-position': 'top' },
				text: 'max tokens',
			});
		}
		if (turn.isApiError) {
			const errorLabel = turn.errorType === 'rate_limit' ? 'rate limit'
				: turn.errorType ?? 'error';
			header.createSpan({
				cls: 'agent-sessions-turn-api-error',
				attr: { 'aria-label': `API error: ${errorLabel}`, 'data-tooltip-position': 'top' },
				text: errorLabel,
			});
			turnEl.addClass('agent-sessions-turn-error');
		}

		makeClickable(header, { label: `Toggle turn ${turn.index + 1}`, expanded: true });
		header.addEventListener('click', () => {
			const willCollapse = !turnEl.hasClass('collapsed');
			turnEl.toggleClass('collapsed', willCollapse);
			header.setAttribute('aria-expanded', String(!willCollapse));
		});

		// Turn body
		const body = turnEl.createDiv({ cls: 'agent-sessions-turn-body' });

		const userBlocks = turn.role === 'user' ? turn.contentBlocks : [];
		const assistantBlocks = turn.role === 'assistant' ? turn.contentBlocks : [];

		// User section
		let blockIdx = 0;
		if (userBlocks.length > 0) {
			const userSection = body.createDiv({ cls: 'agent-sessions-role-section agent-sessions-role-user' });
			userSection.createDiv({ cls: 'agent-sessions-role-label agent-sessions-role-user-label', text: 'USER' });

			for (const block of userBlocks) {
				const wrapper = userSection.createDiv({
					cls: 'agent-sessions-block-wrapper',
					attr: { 'data-block-idx': String(blockIdx++) },
				});
				if (block.type === 'text') {
					this.renderTextContent(block.text, wrapper, 'agent-sessions-user-text');
				} else if (block.type === 'ansi') {
					this.renderAnsiBlock(block as AnsiBlock, wrapper);
				} else if (block.type === 'image') {
					const dataUri = `data:${block.mediaType};base64,${block.data}`;
					const img = wrapper.createEl('img', {
						cls: 'agent-sessions-image-thumbnail',
						attr: { src: dataUri, alt: 'User attachment' },
					});
					makeClickable(img, { label: 'View image attachment' });
					img.addEventListener('click', () => {
						this.openImageModal(dataUri, block.mediaType);
					});
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

	private renderAssistantBlocks(blocks: ContentBlock[], container: HTMLElement, startBlockIdx = 0, groupThreshold?: number): void {
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
				renderToolGroup(seg.blocks, wrapper, this.ctx, this.delegate, groupThreshold);
			}
		}
	}

	private renderSingleBlock(block: ContentBlock, container: HTMLElement): void {
		switch (block.type) {
			case 'text':
				this.renderTextContent(block.text, container, 'agent-sessions-assistant-text');
				break;
			case 'thinking':
				if (this.ctx.settings.showThinkingBlocks) {
					this.renderThinkingBlock(block.thinking, container);
				}
				break;
			case 'compaction':
				this.renderCompactionBlock(block as CompactionBlock, container);
				break;
		}
	}

	private renderTextContent(text: string, container: HTMLElement, cls: string): void {
		const lines = text.split('\n').length;
		const wrapEl = container.createDiv({ cls: 'agent-sessions-text-block' });

		const copyBtn = wrapEl.createEl('button', {
			cls: 'agent-sessions-text-copy',
			attr: { 'aria-label': 'Copy to clipboard', 'data-tooltip-position': 'top' },
		});
		setIcon(copyBtn, 'copy');
		copyBtn.addEventListener('click', () => {
			navigator.clipboard.writeText(text);
			setIcon(copyBtn, 'check');
			setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
		});

		if (lines > COLLAPSE_THRESHOLD) {
			wrapEl.addClass('agent-sessions-collapsible-wrap', 'is-collapsed');
			const contentEl = wrapEl.createDiv({ cls: 'agent-sessions-collapsible-content' });
			const mdEl = contentEl.createDiv({ cls });
			MarkdownRenderer.render(this.ctx.app, text, mdEl, '', this.ctx.component);

			wrapEl.createDiv({ cls: 'agent-sessions-collapsible-fade' });
			const toggleBtn = wrapEl.createEl('button', {
				cls: 'agent-sessions-collapsible-toggle',
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
			const mdEl = wrapEl.createDiv({ cls });
			MarkdownRenderer.render(this.ctx.app, text, mdEl, '', this.ctx.component);
		}
	}

	private renderThinkingBlock(text: string, container: HTMLElement): void {
		const isRedacted = !text.trim();
		const el = container.createDiv({ cls: 'agent-sessions-thinking-block' });

		const header = el.createDiv({ cls: 'agent-sessions-thinking-header' });
		const icon = header.createSpan({ cls: 'agent-sessions-thinking-icon' });
		setIcon(icon, 'brain');
		header.createSpan({ cls: 'agent-sessions-thinking-name', text: 'Thinking' });
		if (isRedacted) {
			header.createSpan({ cls: 'agent-sessions-thinking-redacted', text: 'content encrypted' });
		}
		header.createSpan({ cls: 'agent-sessions-thinking-chevron', text: '\u25B6' });

		const body = el.createDiv({ cls: 'agent-sessions-thinking-body' });
		if (isRedacted) {
			body.createDiv({ cls: 'agent-sessions-thinking-redacted-body', text: 'Thinking content is not available — encrypted by Claude Code.' });
		} else {
			MarkdownRenderer.render(this.ctx.app, text, body, '', this.ctx.component);
		}

		makeClickable(header, { label: 'Toggle thinking block', expanded: false });
		header.addEventListener('click', () => {
			const willOpen = !el.hasClass('open');
			el.toggleClass('open', willOpen);
			header.setAttribute('aria-expanded', String(willOpen));
		});
	}

	/**
	 * Build ANSI-styled DOM nodes directly into a parent element.
	 */
	private buildAnsiDom(text: string, parent: HTMLElement): void {
		const stack: { tag: string; el: HTMLElement }[] = [];
		let current = parent;

		const closeAll = () => {
			while (stack.length) {
				stack.pop();
				current = stack.length ? stack[stack.length - 1].el : parent;
			}
		};

		const closeTo = (tag: string) => {
			const idx = stack.map(s => s.tag).lastIndexOf(tag);
			if (idx === -1) return;
			while (stack.length > idx) {
				stack.pop();
				current = stack.length ? stack[stack.length - 1].el : parent;
			}
		};

		const re = /\x1b\[([\d;]*)m/g;
		let last = 0;
		let match: RegExpExecArray | null;

		while ((match = re.exec(text)) !== null) {
			if (match.index > last) {
				current.appendText(text.slice(last, match.index));
			}
			last = re.lastIndex;

			const params = match[1].split(';').map(Number);
			let i = 0;
			while (i < params.length) {
				const code = params[i];
				if (code === 0 || (isNaN(code) && match[1] === '')) {
					closeAll();
				} else if (code === 1) {
					const span = current.createSpan({ cls: 'ansi-bold' });
					stack.push({ tag: 'bold', el: span });
					current = span;
				} else if (code === 3) {
					const span = current.createSpan({ cls: 'ansi-italic' });
					stack.push({ tag: 'italic', el: span });
					current = span;
				} else if (code === 22 || code === 23) {
					closeTo(code === 22 ? 'bold' : 'italic');
				} else if (code === 38 && params[i + 1] === 2 && i + 4 < params.length) {
					const r = params[i + 2], g = params[i + 3], b = params[i + 4];
					const span = current.createSpan({ cls: 'ansi-fg' });
					span.style.setProperty('--ansi-r', String(r));
					span.style.setProperty('--ansi-g', String(g));
					span.style.setProperty('--ansi-b', String(b));
					stack.push({ tag: 'fg', el: span });
					current = span;
					i += 4;
				} else if (code === 39) {
					closeTo('fg');
				}
				i++;
			}
		}

		if (last < text.length) {
			current.appendText(text.slice(last));
		}
		closeAll();
	}

	private renderAnsiBlock(block: AnsiBlock, container: HTMLElement): void {
		const pre = container.createEl('pre', { cls: 'agent-sessions-ansi-block' });
		this.buildAnsiDom(block.text, pre);
	}

	private renderCompactionBlock(block: CompactionBlock, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'agent-sessions-compaction-block' });
		const divider = el.createDiv({ cls: 'agent-sessions-compaction-divider' });
		const icon = divider.createSpan({ cls: 'agent-sessions-compaction-icon' });
		setIcon(icon, 'scissors');
		divider.createSpan({ text: 'Context compacted' });
		if (block.summary) {
			const summaryEl = el.createDiv({ cls: 'agent-sessions-compaction-summary' });
			MarkdownRenderer.render(this.ctx.app, block.summary, summaryEl, '', this.ctx.component);
		}
	}

	private openImageModal(dataUri: string, mediaType: string): void {
		const modal = new ImagePreviewModal(this.ctx.app, dataUri, mediaType);
		modal.open();
	}
}

class ImagePreviewModal extends Modal {
	private dataUri: string;
	private mediaType: string;

	constructor(app: App, dataUri: string, mediaType: string) {
		super(app);
		this.dataUri = dataUri;
		this.mediaType = SAFE_IMAGE_TYPES.has(mediaType) ? mediaType : 'image/png';
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('agent-sessions-image-preview-modal');
		contentEl.empty();

		const scrollWrap = contentEl.createDiv({ cls: 'agent-sessions-image-preview-scroll' });
		scrollWrap.createEl('img', {
			cls: 'agent-sessions-image-preview',
			attr: { src: this.dataUri, alt: 'Image attachment' },
		});

		const actions = contentEl.createDiv({ cls: 'agent-sessions-image-preview-actions' });
		const downloadBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Download',
			attr: { 'aria-label': 'Download image' },
		});
		downloadBtn.addEventListener('click', () => {
			const ext = this.mediaType.split('/')[1] || 'png';
			const a = document.createElement('a');
			a.href = this.dataUri;
			a.download = `attachment.${ext}`;
			a.click();
		});

		const copyBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Copy',
			attr: { 'aria-label': 'Copy image to clipboard' },
		});
		copyBtn.addEventListener('click', async () => {
			const parts = this.dataUri.split(',');
			const byteString = atob(parts[1]);
			const bytes = new Uint8Array(byteString.length);
			for (let i = 0; i < byteString.length; i++) {
				bytes[i] = byteString.charCodeAt(i);
			}
			const blob = new Blob([bytes], { type: this.mediaType });
			await navigator.clipboard.write([
				new ClipboardItem({ [this.mediaType]: blob }),
			]);
			copyBtn.setText('Copied!');
			setTimeout(() => copyBtn.setText('Copy'), 1500);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
