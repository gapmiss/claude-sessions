import { App, Modal, MarkdownRenderer, Component, setIcon } from 'obsidian';
import {
	Turn, ContentBlock, ToolUseBlock, ToolResultBlock, AnsiBlock, PluginSettings, Session,
} from '../types';

const COLLAPSE_THRESHOLD = 10; // lines before "Show more"
const TOOL_GROUP_THRESHOLD = 4; // consecutive tools before grouping

/** Map file extensions to markdown fence language identifiers. */
const EXT_TO_LANG: Record<string, string> = {
	ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
	py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
	java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
	swift: 'swift', m: 'objectivec',
	sh: 'bash', zsh: 'bash', bash: 'bash', fish: 'fish',
	json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
	xml: 'xml', html: 'html', css: 'css', scss: 'scss', less: 'less',
	sql: 'sql', graphql: 'graphql', gql: 'graphql',
	md: 'markdown', mdx: 'mdx', tex: 'latex',
	dockerfile: 'dockerfile', makefile: 'makefile',
	lua: 'lua', r: 'r', pl: 'perl', php: 'php', ex: 'elixir', erl: 'erlang',
	hs: 'haskell', ml: 'ocaml', scala: 'scala', clj: 'clojure',
	vue: 'vue', svelte: 'svelte', astro: 'astro',
	tf: 'hcl', hcl: 'hcl', nix: 'nix', zig: 'zig', v: 'v',
};

/** Strip `cat -n` style line numbers: leading whitespace + digits + arrow/tab */
function stripLineNumbers(text: string): string {
	return text.replace(/^[ \t]*\d+[\u2192\t][ \t]?/gm, '');
}

/** Extract language from a file path's extension. */
function langFromPath(filePath: string): string {
	const basename = filePath.split('/').pop() ?? '';
	// Handle extensionless names like Makefile, Dockerfile
	const lowerBase = basename.toLowerCase();
	if (lowerBase === 'makefile') return 'makefile';
	if (lowerBase === 'dockerfile') return 'dockerfile';
	const ext = basename.split('.').pop()?.toLowerCase() ?? '';
	return EXT_TO_LANG[ext] ?? '';
}

/** Return a backtick fence string (at least 3) that won't collide with content. */
function fence(content: string, lang = ''): string {
	let max = 2;
	const re = /`{3,}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		if (m[0].length > max) max = m[0].length;
	}
	const ticks = '`'.repeat(max + 1);
	return ticks + lang + '\n' + content + '\n' + ticks;
}

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
	renderTimeline(turns: Turn[], sessionStartMs = 0, session?: Session): HTMLElement[] {
		this.container.empty();
		this.turnEls = [];
		this.sessionStartMs = sessionStartMs;

		if (session) {
			this.renderSummary(session, this.container);
		}

		for (const turn of turns) {
			const el = this.renderTurn(turn);
			this.container.appendChild(el);
			this.turnEls.push(el);
		}

		return this.turnEls;
	}

	/**
	 * Render the session summary panel (collapsible) above the timeline.
	 */
	renderSummary(session: Session, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'agent-sessions-summary' });
		const { metadata, stats } = session;

		// Header (click to toggle)
		const header = el.createDiv({ cls: 'agent-sessions-summary-header' });
		const chevron = header.createSpan({ cls: 'agent-sessions-summary-chevron', text: '\u25B6' });
		const icon = header.createSpan({ cls: 'agent-sessions-summary-icon' });
		setIcon(icon, 'bar-chart-2');
		header.createSpan({ cls: 'agent-sessions-summary-title', text: 'Session summary' });

		// Inline stats in header
		const headerTotalTokens = stats.inputTokens + stats.outputTokens
			+ stats.cacheReadTokens + stats.cacheCreationTokens;
		if (headerTotalTokens > 0) {
			header.createSpan({
				cls: 'agent-sessions-summary-inline',
				text: `${this.formatTokens(headerTotalTokens)} tokens`,
			});
		}
		if (metadata.totalTurns > 0) {
			header.createSpan({
				cls: 'agent-sessions-summary-inline',
				text: `${metadata.totalTurns} turns`,
			});
		}

		// Body (collapsed by default)
		const body = el.createDiv({ cls: 'agent-sessions-summary-body' });

		header.addEventListener('click', () => {
			const isOpen = el.hasClass('open');
			el.toggleClass('open', !isOpen);
			chevron.setText(isOpen ? '\u25B6' : '\u25BC');
		});

		// --- Session ID ---
		const idSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
		idSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Session ID' });
		const idRow = idSection.createDiv({ cls: 'agent-sessions-summary-id-row' });
		idRow.createSpan({ cls: 'agent-sessions-summary-value agent-sessions-summary-mono', text: metadata.id });
		this.addCopyButton(idRow, metadata.id, 'Copy session ID');
		this.addCopyButton(idRow, session.rawPath, 'Copy file path');

		// --- Obsidian URI ---
		const obsidianUri = `obsidian://agent-sessions?session=${encodeURIComponent(session.rawPath)}`;
		const mdLink = `[${metadata.project} session](${obsidianUri})`;

		const uriSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
		uriSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Obsidian URI' });
		const uriRow = uriSection.createDiv({ cls: 'agent-sessions-summary-id-row' });
		const uriPreview = obsidianUri.length > 60
			? obsidianUri.substring(0, 60) + '...'
			: obsidianUri;
		uriRow.createSpan({ cls: 'agent-sessions-summary-value agent-sessions-summary-mono', text: uriPreview });
		this.addCopyButton(uriRow, obsidianUri, 'Copy URI');
		this.addCopyButton(uriRow, mdLink, 'Copy markdown link');

		// --- Metadata grid ---
		const grid = body.createDiv({ cls: 'agent-sessions-summary-grid' });

		if (metadata.project) this.addGridItem(grid, 'Project', metadata.project);
		if (metadata.model) this.addGridItem(grid, 'Model', metadata.model);
		if (metadata.version) this.addGridItem(grid, 'Version', metadata.version);
		if (metadata.branch) this.addGridItem(grid, 'Branch', metadata.branch);
		if (metadata.cwd) this.addGridItem(grid, 'Working dir', metadata.cwd);
		if (metadata.startTime) {
			const d = new Date(metadata.startTime);
			this.addGridItem(grid, 'Started', d.toLocaleString());
		}
		if (stats.durationMs > 0) {
			this.addGridItem(grid, 'Duration', this.formatDuration(stats.durationMs));
		}

		// --- Turns ---
		const turnsSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
		turnsSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Turns' });
		const turnsGrid = turnsSection.createDiv({ cls: 'agent-sessions-summary-grid' });
		this.addGridItem(turnsGrid, 'User', String(stats.userTurns));
		this.addGridItem(turnsGrid, 'Assistant', String(stats.assistantTurns));
		this.addGridItem(turnsGrid, 'Total', String(metadata.totalTurns));

		// --- Tokens ---
		const totalInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
		if (totalInput > 0 || stats.outputTokens > 0) {
			const tokenSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
			tokenSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Tokens' });
			const tokenGrid = tokenSection.createDiv({ cls: 'agent-sessions-summary-grid' });
			this.addGridItem(tokenGrid, 'Input (total)', this.formatTokens(totalInput));
			this.addGridItem(tokenGrid, 'Output', this.formatTokens(stats.outputTokens));
			if (stats.cacheReadTokens > 0) {
				this.addGridItem(tokenGrid, 'Cache read', this.formatTokens(stats.cacheReadTokens));
			}
			if (stats.cacheCreationTokens > 0) {
				this.addGridItem(tokenGrid, 'Cache write', this.formatTokens(stats.cacheCreationTokens));
			}
			if (stats.inputTokens > 0) {
				this.addGridItem(tokenGrid, 'Uncached', this.formatTokens(stats.inputTokens));
			}
		}

		// --- Tool usage ---
		const toolNames = Object.keys(stats.toolUseCounts);
		if (toolNames.length > 0) {
			const toolSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
			toolSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Tool usage' });
			const toolGrid = toolSection.createDiv({ cls: 'agent-sessions-summary-grid' });
			// Sort by count descending
			toolNames
				.sort((a, b) => stats.toolUseCounts[b] - stats.toolUseCounts[a])
				.forEach(name => {
					this.addGridItem(toolGrid, name, String(stats.toolUseCounts[name]));
				});
		}
	}

	private addCopyButton(container: HTMLElement, text: string, label: string): void {
		const btn = container.createEl('button', {
			cls: 'agent-sessions-summary-copy',
			attr: { 'aria-label': label, 'data-tooltip-position': 'top' },
		});
		setIcon(btn, 'copy');
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			navigator.clipboard.writeText(text);
			setIcon(btn, 'check');
			setTimeout(() => setIcon(btn, 'copy'), 1500);
		});
	}

	private addGridItem(grid: HTMLElement, label: string, value: string): void {
		grid.createSpan({ cls: 'agent-sessions-summary-grid-label', text: label });
		grid.createSpan({ cls: 'agent-sessions-summary-grid-value', text: value });
	}

	private formatTokens(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
		if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
		return String(n);
	}

	private formatDuration(ms: number): string {
		const totalSec = Math.round(ms / 1000);
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		const s = totalSec % 60;
		if (h > 0) return `${h}h ${m}m`;
		if (m > 0) return `${m}m ${s}s`;
		return `${s}s`;
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
		if (block.hooks && block.hooks.length > 0) {
			const hookNames = [...new Set(block.hooks.map(h => h.hookName))].join(', ');
			const hookIcon = header.createSpan({
				cls: 'agent-sessions-hook-icon',
				attr: { 'aria-label': hookNames, 'data-tooltip-position': 'top' },
			});
			setIcon(hookIcon, 'fish');
		}
		const chevron = header.createSpan({ cls: 'agent-sessions-tool-chevron', text: '\u25B6' });

		// Body (hidden by default)
		const body = toolEl.createDiv({ cls: 'agent-sessions-tool-body' });

		// Input section
		if (block.name === 'Edit' && block.input['old_string'] != null) {
			this.renderDiffView(block, result, body);
		} else if (block.name === 'Write' && block.input['content'] != null) {
			this.renderWriteView(block, result, body);
		} else if (block.name === 'Bash') {
			this.renderBashInput(block, body);
		} else {
			const inputEl = body.createDiv({ cls: 'agent-sessions-tool-input' });
			inputEl.createDiv({ cls: 'agent-sessions-tool-section-label', text: 'INPUT' });
			const inputText = this.formatInput(block.input);
			const inputMd = fence(inputText, 'json');
			const inputMdContainer = inputEl.createDiv({ cls: 'agent-sessions-tool-input-code' });
			MarkdownRenderer.render(this.app, inputMd, inputMdContainer, '', this.component);
		}

		// Result section (skip for Edit/Write which render their own results)
		if (result && this.settings.showToolResults
			&& !(block.name === 'Edit' && block.input['old_string'] != null)
			&& !(block.name === 'Write' && block.input['content'] != null)) {
			const resultEl = body.createDiv({
				cls: `agent-sessions-tool-result ${isError ? 'agent-sessions-tool-result-error' : ''}`,
			});
			resultEl.createDiv({ cls: 'agent-sessions-tool-section-label', text: 'RESULT' });
			const resultText = result.content.length > 5000
				? result.content.substring(0, 5000) + '\n... (truncated)'
				: result.content;

			if (block.name === 'Read' && !isError) {
				// Render as syntax-highlighted code block via MarkdownRenderer
				const filePath = String(block.input['file_path'] || '');
				const lang = langFromPath(filePath);
				const cleaned = stripLineNumbers(resultText);
				const md = fence(cleaned, lang);
				const mdContainer = resultEl.createDiv({ cls: 'agent-sessions-read-result' });
				MarkdownRenderer.render(this.app, md, mdContainer, '', this.component);
			} else if (block.name === 'Bash' && !isError && this.isBashDiffResult(block, resultText)) {
				const resultMd = fence(resultText, 'diff');
				const resultMdContainer = resultEl.createDiv({ cls: 'agent-sessions-tool-result-code' });
				MarkdownRenderer.render(this.app, resultMd, resultMdContainer, '', this.component);
			} else {
				const resultMd = fence(resultText);
				const resultMdContainer = resultEl.createDiv({ cls: 'agent-sessions-tool-result-code' });
				MarkdownRenderer.render(this.app, resultMd, resultMdContainer, '', this.component);
			}
		}

		header.addEventListener('click', () => {
			const isOpen = toolEl.hasClass('open');
			toolEl.toggleClass('open', !isOpen);
			chevron.setText(isOpen ? '\u25B6' : '\u25BC');
		});
	}

	private renderBashInput(block: ToolUseBlock, container: HTMLElement): void {
		const inputEl = container.createDiv({ cls: 'agent-sessions-tool-input' });
		const labelRow = inputEl.createDiv({ cls: 'agent-sessions-tool-section-label' });
		labelRow.createSpan({ text: 'INPUT' });
		const description = String(block.input['description'] || '');
		if (description) {
			labelRow.createSpan({ cls: 'agent-sessions-tool-section-desc', text: description });
		}
		const command = String(block.input['command'] || '');
		const md = fence(command, 'bash');
		const mdContainer = inputEl.createDiv({ cls: 'agent-sessions-tool-input-code' });
		MarkdownRenderer.render(this.app, md, mdContainer, '', this.component);
	}

	/** Check if a Bash tool result looks like diff/patch output. */
	private isBashDiffResult(block: ToolUseBlock, resultText: string): boolean {
		const command = String(block.input['command'] || '').toLowerCase();
		if (!/\bdiff\b/.test(command)) return false;
		// Verify the result looks like unified diff output
		return /^(diff\s|---\s|@@\s)/m.test(resultText);
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

		// Build unified diff content for a diff code block
		const diffLines: string[] = [];
		for (const line of oldStr.split('\n')) {
			diffLines.push('- ' + line);
		}
		for (const line of newStr.split('\n')) {
			diffLines.push('+ ' + line);
		}

		const md = fence(diffLines.join('\n'), 'diff');
		const mdContainer = diffEl.createDiv({ cls: 'agent-sessions-diff-code' });
		MarkdownRenderer.render(this.app, md, mdContainer, '', this.component);

		if (result?.isError) {
			diffEl.createDiv({
				cls: 'agent-sessions-diff-result agent-sessions-diff-result-error',
				text: result.content,
			});
		}
	}

	private renderWriteView(block: ToolUseBlock, result: ToolResultBlock | undefined, container: HTMLElement): void {
		const writeEl = container.createDiv({ cls: 'agent-sessions-tool-input' });

		const filePath = String(block.input['file_path'] || '');
		if (filePath) {
			writeEl.createDiv({ cls: 'agent-sessions-diff-file', text: filePath });
		}

		const content = String(block.input['content'] || '');
		const lang = langFromPath(filePath);
		const md = fence(content, lang);
		const mdContainer = writeEl.createDiv({ cls: 'agent-sessions-tool-input-code' });
		MarkdownRenderer.render(this.app, md, mdContainer, '', this.component);

		if (result?.isError) {
			const resultEl = container.createDiv({
				cls: 'agent-sessions-tool-result agent-sessions-tool-result-error',
			});
			resultEl.createDiv({ cls: 'agent-sessions-tool-section-label', text: 'RESULT' });
			const resultMd = fence(result.content);
			const resultMdContainer = resultEl.createDiv({ cls: 'agent-sessions-tool-result-code' });
			MarkdownRenderer.render(this.app, resultMd, resultMdContainer, '', this.component);
		}
	}

	private renderThinkingBlock(text: string, container: HTMLElement): void {
		const isRedacted = !text.trim();
		const el = container.createDiv({ cls: 'agent-sessions-thinking-block' });

		// Header bar (matches tool call style)
		const header = el.createDiv({ cls: 'agent-sessions-thinking-header' });
		const icon = header.createSpan({ cls: 'agent-sessions-thinking-icon' });
		setIcon(icon, 'brain');
		header.createSpan({ cls: 'agent-sessions-thinking-name', text: 'Thinking' });
		if (isRedacted) {
			header.createSpan({ cls: 'agent-sessions-thinking-redacted', text: 'content encrypted' });
		}
		const chevron = header.createSpan({ cls: 'agent-sessions-thinking-chevron', text: '\u25B6' });

		// Body (collapsible)
		const body = el.createDiv({ cls: 'agent-sessions-thinking-body' });
		if (isRedacted) {
			body.createDiv({ cls: 'agent-sessions-thinking-redacted-body', text: 'Thinking content is not available — encrypted by Claude Code.' });
		} else {
			MarkdownRenderer.render(this.app, text, body, '', this.component);
		}

		header.addEventListener('click', () => {
			const isOpen = el.hasClass('open');
			el.toggleClass('open', !isOpen);
			chevron.setText(isOpen ? '\u25BC' : '\u25B6');
		});
	}

	private renderTextContent(text: string, container: HTMLElement, cls: string): void {
		const lines = text.split('\n').length;
		const wrapEl = container.createDiv({ cls: 'agent-sessions-text-block' });

		// Copy button
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

	/**
	 * Convert ANSI escape sequences to HTML spans.
	 * Handles: bold (1/22), italic (3/23), 24-bit fg color (38;2;R;G;B), default fg (39), reset (0).
	 */
	private ansiToHtml(text: string): string {
		const out: string[] = [];
		const openTags: string[] = [];

		const closeAll = () => {
			while (openTags.length) {
				out.push('</span>');
				openTags.pop();
			}
		};

		const re = /\x1b\[([\d;]*)m/g;
		let last = 0;
		let match: RegExpExecArray | null;

		while ((match = re.exec(text)) !== null) {
			// Push text between escapes (HTML-escaped)
			if (match.index > last) {
				out.push(this.escapeHtml(text.slice(last, match.index)));
			}
			last = re.lastIndex;

			const params = match[1].split(';').map(Number);
			let i = 0;
			while (i < params.length) {
				const code = params[i];
				if (code === 0 || (isNaN(code) && match[1] === '')) {
					closeAll();
				} else if (code === 1) {
					out.push('<span class="ansi-bold">');
					openTags.push('bold');
				} else if (code === 3) {
					out.push('<span class="ansi-italic">');
					openTags.push('italic');
				} else if (code === 22 || code === 23) {
					// End bold/italic — pop the most recent matching tag
					const target = code === 22 ? 'bold' : 'italic';
					const idx = openTags.lastIndexOf(target);
					if (idx !== -1) {
						// Close tags down to and including the target
						for (let j = openTags.length - 1; j >= idx; j--) {
							out.push('</span>');
							openTags.pop();
						}
					}
				} else if (code === 38 && params[i + 1] === 2 && i + 4 < params.length) {
					const r = params[i + 2], g = params[i + 3], b = params[i + 4];
					out.push(`<span class="ansi-fg" style="--ansi-r:${r};--ansi-g:${g};--ansi-b:${b}">`);
					openTags.push('fg');
					i += 4; // skip the 2;R;G;B params
				} else if (code === 39) {
					// Reset foreground — close the last fg span
					const idx = openTags.lastIndexOf('fg');
					if (idx !== -1) {
						for (let j = openTags.length - 1; j >= idx; j--) {
							out.push('</span>');
							openTags.pop();
						}
					}
				}
				i++;
			}
		}

		// Remaining text
		if (last < text.length) {
			out.push(this.escapeHtml(text.slice(last)));
		}
		closeAll();
		return out.join('');
	}

	private escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	private renderAnsiBlock(block: AnsiBlock, container: HTMLElement): void {
		const pre = container.createEl('pre', { cls: 'agent-sessions-ansi-block' });
		// Use innerHTML for ANSI-converted spans — input is from parsed session data, not user HTML
		pre.innerHTML = this.ansiToHtml(block.text);
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

	private openImageModal(dataUri: string, mediaType: string): void {
		const modal = new ImagePreviewModal(this.app, dataUri, mediaType);
		modal.open();
	}
}

class ImagePreviewModal extends Modal {
	private dataUri: string;
	private mediaType: string;

	constructor(app: App, dataUri: string, mediaType: string) {
		super(app);
		this.dataUri = dataUri;
		this.mediaType = mediaType;
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
