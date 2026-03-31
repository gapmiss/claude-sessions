import { App, Modal, MarkdownRenderer, Component, setIcon } from 'obsidian';
import type {
	Turn, ContentBlock, AnsiBlock, CompactionBlock, SlashCommandBlock, BashCommandBlock,
	PluginSettings, Session,
} from '../types';
import {
	type RenderContext, COLLAPSE_THRESHOLD,
	makeClickable, shortModelName, addCopyButton, normalizeMarkdown, fence,
} from './render-helpers';
import { renderSummary } from './summary-renderer';
import { renderToolGroup, type ToolRendererDelegate } from './tool-renderer';

const SAFE_IMAGE_TYPES = new Set([
	'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff',
]);

export class TimelineRenderer {
	private container: HTMLElement;
	private ctx: RenderContext;
	private turnEls: HTMLElement[] = [];
	private sessionStartDate = '';  // tracks day changes across turns
	private delegate: ToolRendererDelegate;
	private mermaidObserver: MutationObserver | null = null;
	private mermaidRafId = 0;

	constructor(container: HTMLElement, app: App, component: Component, settings: PluginSettings) {
		this.container = container;
		this.ctx = { app, component, settings };
		this.delegate = {
			renderAssistantBlocks: this.renderAssistantBlocks.bind(this),
			renderTextContent: this.renderTextContent.bind(this),
			buildAnsiDom: this.buildAnsiDom.bind(this),
			openImageModal: this.openImageModal.bind(this),
			taskState: new Map(),
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
	renderTimeline(turns: Turn[], _sessionStartMs = 0, session?: Session): HTMLElement[] {
		this.container.empty();
		this.turnEls = [];
		this.sessionStartDate = '';
		this.delegate.taskState.clear();

		if (session) {
			renderSummary(session, this.container, this.ctx);
		}

		for (const turn of turns) {
			const el = this.renderTurn(turn);
			this.container.appendChild(el);
			this.turnEls.push(el);
		}

		this.setupMermaidObserver();
		this.processMermaidBlocks(this.container);

		return this.turnEls;
	}

	/**
	 * Clean up the MutationObserver for mermaid detection.
	 * Called by the view on close.
	 */
	destroyMermaidObserver(): void {
		if (this.mermaidRafId) {
			cancelAnimationFrame(this.mermaidRafId);
			this.mermaidRafId = 0;
		}
		if (this.mermaidObserver) {
			this.mermaidObserver.disconnect();
			this.mermaidObserver = null;
		}
	}

	/**
	 * Get all block wrapper elements within a specific turn element.
	 */
	getBlockWrappers(turnIndex: number): HTMLElement[] {
		const turnEl = this.turnEls[turnIndex];
		if (!turnEl) return [];
		return Array.from(turnEl.querySelectorAll('.claude-sessions-block-wrapper')) as HTMLElement[];
	}

	private setupMermaidObserver(): void {
		this.destroyMermaidObserver();
		this.mermaidObserver = new MutationObserver(() => {
			if (!this.mermaidRafId) {
				this.mermaidRafId = requestAnimationFrame(() => {
					this.mermaidRafId = 0;
					this.processMermaidBlocks(this.container);
				});
			}
		});
		this.mermaidObserver.observe(this.container, { childList: true, subtree: true });
	}

	private processMermaidBlocks(root: HTMLElement): void {
		const els = root.querySelectorAll('div.mermaid:not(.claude-sessions-mermaid-processed)');
		for (const el of Array.from(els) as HTMLElement[]) {
			const svg = el.querySelector('svg');
			if (!svg) continue;

			el.addClass('claude-sessions-mermaid-processed');

			const parent = el.parentElement;
			if (!parent) continue;

			const wrapper = parent.createDiv({ cls: 'claude-sessions-mermaid-container' });
			parent.insertBefore(wrapper, el);
			wrapper.appendChild(el);

			const expandIcon = wrapper.createDiv({ cls: 'claude-sessions-mermaid-expand' });
			setIcon(expandIcon, 'maximize-2');

			makeClickable(wrapper, { label: 'View full diagram' });
			wrapper.addEventListener('click', () => {
				new MermaidPreviewModal(this.ctx.app, svg as SVGElement).open();
			});
		}
	}

	private renderTurn(turn: Turn): HTMLElement {
		const turnEl = this.container.createDiv({
			cls: 'claude-sessions-turn',
			attr: { 'data-turn-index': String(turn.index) },
		});

		// Turn header (collapsible)
		const roleClass = turn.role === 'user' ? 'claude-sessions-turn-role-user' : 'claude-sessions-turn-role-assistant';
		const header = turnEl.createDiv({ cls: 'claude-sessions-turn-header' });
		header.createSpan({ cls: 'claude-sessions-turn-chevron', text: '\u25B6' });
		header.createSpan({ cls: `claude-sessions-turn-role ${roleClass}`, text: turn.role === 'user' ? 'USER' : 'CLAUDE' });
		header.createSpan({ cls: 'claude-sessions-turn-label', text: `(Turn #${turn.index + 1})` });

		if (turn.timestamp) {
			const d = new Date(turn.timestamp);
			if (!isNaN(d.getTime())) {
				const dateStr = d.toDateString();
				const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
				let label: string;
				if (this.sessionStartDate && dateStr !== this.sessionStartDate) {
					// Day changed — show date prefix
					const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
					label = `${date}, ${time}`;
				} else {
					label = time;
				}
				if (!this.sessionStartDate) this.sessionStartDate = dateStr;
				header.createSpan({ cls: 'claude-sessions-turn-ts', text: label });
			}
		}

		if (turn.model) {
			const main = shortModelName(turn.model);
			// Collect distinct sub-agent models
			const subModels = new Set<string>();
			for (const b of turn.contentBlocks) {
				if (b.type === 'tool_use' && b.subAgentSession) {
					for (const t of b.subAgentSession.turns) {
						if (t.model && shortModelName(t.model) !== main) {
							subModels.add(shortModelName(t.model));
							break;
						}
					}
				}
			}
			const label = subModels.size > 0
				? `${main} → ${[...subModels].join(', ')}`
				: main;
			header.createSpan({ cls: 'claude-sessions-turn-model', text: label });
		}
		if (turn.stopReason === 'max_tokens') {
			header.createSpan({
				cls: 'claude-sessions-turn-stop-reason',
				attr: { 'aria-label': 'Response truncated (max tokens)', 'data-tooltip-position': 'top' },
				text: 'max tokens',
			});
		}
		if (turn.isApiError) {
			const errorLabel = turn.errorType === 'rate_limit' ? 'rate limit'
				: turn.errorType ?? 'error';
			header.createSpan({
				cls: 'claude-sessions-turn-api-error',
				attr: { 'aria-label': `API error: ${errorLabel}`, 'data-tooltip-position': 'top' },
				text: errorLabel,
			});
			turnEl.addClass('claude-sessions-turn-error');
		}

		makeClickable(header, { label: `Toggle turn ${turn.index + 1}`, expanded: true });
		header.addEventListener('click', () => {
			const willCollapse = !turnEl.hasClass('collapsed');
			turnEl.toggleClass('collapsed', willCollapse);
			header.setAttribute('aria-expanded', String(!willCollapse));
		});

		// Turn body
		const body = turnEl.createDiv({ cls: 'claude-sessions-turn-body' });

		const userBlocks = turn.role === 'user' ? turn.contentBlocks : [];
		const assistantBlocks = turn.role === 'assistant' ? turn.contentBlocks : [];

		// User section
		let blockIdx = 0;
		if (userBlocks.length > 0) {
			const userSection = body.createDiv({ cls: 'claude-sessions-role-section claude-sessions-role-user' });

			for (const block of userBlocks) {
				const wrapper = userSection.createDiv({
					cls: 'claude-sessions-block-wrapper',
					attr: { 'data-block-idx': String(blockIdx++) },
				});
				if (block.type === 'text') {
					this.renderTextContent(block.text, wrapper, 'claude-sessions-user-text');
				} else if (block.type === 'slash_command') {
					this.renderSlashCommandBlock(block as SlashCommandBlock, wrapper);
				} else if (block.type === 'bash_command') {
					this.renderBashCommandBlock(block as BashCommandBlock, wrapper);
				} else if (block.type === 'ansi') {
					this.renderAnsiBlock(block as AnsiBlock, wrapper);
				} else if (block.type === 'image') {
					const dataUri = `data:${block.mediaType};base64,${block.data}`;
					const img = wrapper.createEl('img', {
						cls: 'claude-sessions-image-thumbnail',
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
			const assistantSection = body.createDiv({ cls: 'claude-sessions-role-section claude-sessions-role-assistant' });

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
				cls: 'claude-sessions-block-wrapper',
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
				this.renderTextContent(block.text, container, 'claude-sessions-assistant-text');
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
		text = normalizeMarkdown(text);
		const lines = text.split('\n').length;
		const wrapEl = container.createDiv({ cls: 'claude-sessions-text-block' });

		const copyBtn = wrapEl.createEl('button', {
			cls: 'claude-sessions-text-copy clickable-icon',
			attr: { 'aria-label': 'Copy to clipboard', 'data-tooltip-position': 'top' },
		});
		setIcon(copyBtn, 'copy');
		copyBtn.addEventListener('click', () => {
			navigator.clipboard.writeText(text);
			setIcon(copyBtn, 'check');
			setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
		});

		if (lines > COLLAPSE_THRESHOLD) {
			wrapEl.addClass('claude-sessions-collapsible-wrap', 'is-collapsed');
			const contentEl = wrapEl.createDiv({ cls: 'claude-sessions-collapsible-content' });
			const mdEl = contentEl.createDiv({ cls });
			MarkdownRenderer.render(this.ctx.app, text, mdEl, '', this.ctx.component);

			wrapEl.createDiv({ cls: 'claude-sessions-collapsible-fade' });
			const toggleBtn = wrapEl.createEl('button', {
				cls: 'claude-sessions-collapsible-toggle',
				text: `Show more (${lines} lines)`,
				attr: { 'aria-expanded': 'false', 'data-line-count': String(lines) },
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
		const el = container.createDiv({ cls: 'claude-sessions-thinking-block' });

		const header = el.createDiv({ cls: 'claude-sessions-thinking-header' });
		const icon = header.createSpan({ cls: 'claude-sessions-thinking-icon' });
		setIcon(icon, 'brain');
		header.createSpan({ cls: 'claude-sessions-thinking-name', text: 'Thinking' });
		if (isRedacted) {
			header.createSpan({ cls: 'claude-sessions-thinking-redacted', text: 'content encrypted' });
		}
		header.createSpan({ cls: 'claude-sessions-thinking-chevron', text: '\u25B6' });

		const body = el.createDiv({ cls: 'claude-sessions-thinking-body' });
		if (isRedacted) {
			body.createDiv({ cls: 'claude-sessions-thinking-redacted-body', text: 'Thinking content is not available — encrypted by Claude Code.' });
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

	private renderSlashCommandBlock(block: SlashCommandBlock, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'claude-sessions-slash-command-block' });

		const header = el.createDiv({ cls: 'claude-sessions-slash-command-header' });
		const icon = header.createSpan({ cls: 'claude-sessions-slash-command-icon' });
		setIcon(icon, 'file-text');
		header.createSpan({ cls: 'claude-sessions-slash-command-name', text: 'Slash output' });
		addCopyButton(header, block.text, 'Copy slash command output');
		header.createSpan({ cls: 'claude-sessions-slash-command-chevron', text: '\u25B6' });

		const body = el.createDiv({ cls: 'claude-sessions-slash-command-body' });
		MarkdownRenderer.render(this.ctx.app, block.text, body, '', this.ctx.component);

		makeClickable(header, { label: 'Toggle slash command output', expanded: false });
		header.addEventListener('click', () => {
			const willOpen = !el.hasClass('open');
			el.toggleClass('open', willOpen);
			header.setAttribute('aria-expanded', String(willOpen));
		});
	}

	private renderBashCommandBlock(block: BashCommandBlock, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'claude-sessions-bash-command-block' });

		// Command as bash code block with INPUT label
		const commandEl = el.createDiv({ cls: 'claude-sessions-bash-command-input' });
		commandEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'INPUT' });
		MarkdownRenderer.render(this.ctx.app, fence(block.command, 'bash'), commandEl, '', this.ctx.component);

		// Result section with RESULT label (always shown, even if empty)
		const resultEl = el.createDiv({ cls: 'claude-sessions-bash-command-stdout' });
		resultEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'RESULT' });
		if (block.stdout.trim()) {
			MarkdownRenderer.render(this.ctx.app, fence(block.stdout), resultEl, '', this.ctx.component);
		}

		// Stderr (if non-empty)
		if (block.stderr.trim()) {
			const stderrEl = el.createDiv({ cls: 'claude-sessions-bash-command-stderr' });
			stderrEl.createDiv({ cls: 'claude-sessions-tool-section-label', text: 'STDERR' });
			MarkdownRenderer.render(this.ctx.app, fence(block.stderr), stderrEl, '', this.ctx.component);
		}
	}

	/**
	 * Build ANSI-styled DOM nodes directly into a parent element.
	 */
	// Standard 4-bit ANSI color palette (indices 0-7 for codes 30-37/40-47, 8-15 for 90-97/100-107)
	private static readonly ANSI_COLORS: string[] = [
		'#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#aaaaaa', // standard (dimmed for dark bg)
		'#888888', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff', // bright
	];

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
				} else if (code === 2) {
					const span = current.createSpan({ cls: 'ansi-dim' });
					stack.push({ tag: 'dim', el: span });
					current = span;
				} else if (code === 3) {
					const span = current.createSpan({ cls: 'ansi-italic' });
					stack.push({ tag: 'italic', el: span });
					current = span;
				} else if (code === 4) {
					const span = current.createSpan({ cls: 'ansi-underline' });
					stack.push({ tag: 'underline', el: span });
					current = span;
				} else if (code === 22) {
					closeTo('bold');
					closeTo('dim');
				} else if (code === 23) {
					closeTo('italic');
				} else if (code === 24) {
					closeTo('underline');
				} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
					closeTo('fg');
					const idx = code >= 90 ? (code - 90 + 8) : (code - 30);
					const span = current.createSpan({ cls: 'ansi-fg' });
					span.style.color = TimelineRenderer.ANSI_COLORS[idx];
					stack.push({ tag: 'fg', el: span });
					current = span;
				} else if (code === 38 && params[i + 1] === 2 && i + 4 < params.length) {
					closeTo('fg');
					const r = params[i + 2], g = params[i + 3], b = params[i + 4];
					const span = current.createSpan({ cls: 'ansi-fg' });
					span.style.color = `rgb(${r},${g},${b})`;
					stack.push({ tag: 'fg', el: span });
					current = span;
					i += 4;
				} else if (code === 39) {
					closeTo('fg');
				} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
					closeTo('bg');
					const idx = code >= 100 ? (code - 100 + 8) : (code - 40);
					const span = current.createSpan({ cls: 'ansi-bg' });
					span.style.backgroundColor = TimelineRenderer.ANSI_COLORS[idx];
					stack.push({ tag: 'bg', el: span });
					current = span;
				} else if (code === 48 && params[i + 1] === 2 && i + 4 < params.length) {
					closeTo('bg');
					const r = params[i + 2], g = params[i + 3], b = params[i + 4];
					const span = current.createSpan({ cls: 'ansi-bg' });
					span.style.backgroundColor = `rgb(${r},${g},${b})`;
					stack.push({ tag: 'bg', el: span });
					current = span;
					i += 4;
				} else if (code === 49) {
					closeTo('bg');
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
		const pre = container.createEl('pre', { cls: 'claude-sessions-ansi-block' });
		this.buildAnsiDom(block.text, pre);
	}

	private renderCompactionBlock(block: CompactionBlock, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'claude-sessions-compaction-block' });
		const divider = el.createDiv({ cls: 'claude-sessions-compaction-divider' });
		const icon = divider.createSpan({ cls: 'claude-sessions-compaction-icon' });
		setIcon(icon, 'scissors');
		divider.createSpan({ text: 'Context compacted' });
		if (block.summary) {
			const summaryEl = el.createDiv({ cls: 'claude-sessions-compaction-summary' });
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
		this.modalEl.addClass('claude-sessions-image-preview-modal');
		contentEl.empty();

		const scrollWrap = contentEl.createDiv({ cls: 'claude-sessions-image-preview-scroll' });
		scrollWrap.createEl('img', {
			cls: 'claude-sessions-image-preview',
			attr: { src: this.dataUri, alt: 'Image attachment' },
		});

		const actions = contentEl.createDiv({ cls: 'claude-sessions-image-preview-actions' });
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

class MermaidPreviewModal extends Modal {
	private svgEl: SVGElement;

	constructor(app: App, svgEl: SVGElement) {
		super(app);
		this.svgEl = svgEl;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('claude-sessions-mermaid-preview-modal');
		contentEl.empty();

		const scrollWrap = contentEl.createDiv({ cls: 'claude-sessions-mermaid-preview-scroll markdown-rendered' });

		// Remap SVG IDs to avoid collision with the original (duplicate IDs
		// cause the clone's internal <style> to target the original instead)
		const origId = this.svgEl.id;
		let svgString = new XMLSerializer().serializeToString(this.svgEl);
		if (origId) {
			svgString = svgString.split(origId).join('mermaid-preview-' + Date.now());
		}
		const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
		const svgNode = document.importNode(doc.documentElement, true) as unknown as HTMLElement;
		// Mermaid sets an inline max-width that caps the SVG size — remove it so it fills the modal
		svgNode.style.removeProperty('max-width');

		const mermaidWrap = scrollWrap.createDiv({ cls: 'mermaid' });
		mermaidWrap.appendChild(svgNode);

		const actions = contentEl.createDiv({ cls: 'claude-sessions-mermaid-preview-actions' });

		const downloadBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Download SVG',
			attr: { 'aria-label': 'Download as SVG file' },
		});
		downloadBtn.addEventListener('click', () => {
			const svgString = new XMLSerializer().serializeToString(this.svgEl);
			const blob = new Blob([svgString], { type: 'image/svg+xml' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'diagram.svg';
			a.click();
			URL.revokeObjectURL(url);
		});

		const copyBtn = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Copy SVG',
			attr: { 'aria-label': 'Copy SVG to clipboard' },
		});
		copyBtn.addEventListener('click', async () => {
			const svgString = new XMLSerializer().serializeToString(this.svgEl);
			await navigator.clipboard.writeText(svgString);
			copyBtn.setText('Copied!');
			setTimeout(() => copyBtn.setText('Copy SVG'), 1500);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
