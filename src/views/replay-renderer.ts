import { App, MarkdownRenderer, Component } from 'obsidian';
import {
	Turn, ContentBlock, TextBlock, ThinkingBlock,
	ToolUseBlock, ToolResultBlock, PluginSettings,
} from '../types';

export class ReplayRenderer {
	private container: HTMLElement;
	private app: App;
	private component: Component;
	private settings: PluginSettings;

	constructor(container: HTMLElement, app: App, component: Component, settings: PluginSettings) {
		this.container = container;
		this.app = app;
		this.component = component;
		this.settings = settings;
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	renderTurn(turn: Turn): void {
		this.container.empty();

		const turnEl = this.container.createDiv({
			cls: `agent-sessions-turn agent-sessions-turn-${turn.role}`,
		});

		// Turn header
		const header = turnEl.createDiv({ cls: 'agent-sessions-turn-header' });
		const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
		header.createSpan({
			cls: `agent-sessions-role agent-sessions-role-${turn.role}`,
			text: roleLabel,
		});

		if (turn.timestamp) {
			const date = new Date(turn.timestamp);
			header.createSpan({
				cls: 'agent-sessions-timestamp',
				text: date.toLocaleString(),
			});
		}

		// Content blocks
		const contentEl = turnEl.createDiv({ cls: 'agent-sessions-turn-content' });
		for (const block of turn.contentBlocks) {
			this.renderBlock(block, contentEl);
		}
	}

	private renderBlock(block: ContentBlock, container: HTMLElement): void {
		switch (block.type) {
			case 'text':
				this.renderTextBlock(block, container);
				break;
			case 'thinking':
				if (this.settings.showThinkingBlocks) {
					this.renderThinkingBlock(block, container);
				}
				break;
			case 'tool_use':
				if (this.settings.showToolCalls) {
					this.renderToolUseBlock(block, container);
				}
				break;
			case 'tool_result':
				if (this.settings.showToolResults) {
					this.renderToolResultBlock(block, container);
				}
				break;
		}
	}

	private renderTextBlock(block: TextBlock, container: HTMLElement): void {
		const el = container.createDiv({ cls: 'agent-sessions-text-block' });
		MarkdownRenderer.render(
			this.app,
			block.text,
			el,
			'',
			this.component,
		);
	}

	private renderThinkingBlock(block: ThinkingBlock, container: HTMLElement): void {
		const details = container.createEl('details', {
			cls: 'agent-sessions-thinking-block',
		});
		const summary = details.createEl('summary', {
			cls: 'agent-sessions-thinking-summary',
		});
		summary.createSpan({
			cls: 'agent-sessions-block-icon',
			text: '\u{1F4AD}',
		});
		summary.createSpan({ text: ' Thinking' });

		const content = details.createDiv({ cls: 'agent-sessions-thinking-content' });
		MarkdownRenderer.render(
			this.app,
			block.thinking,
			content,
			'',
			this.component,
		);
	}

	private renderToolUseBlock(block: ToolUseBlock, container: HTMLElement): void {
		const details = container.createEl('details', {
			cls: 'agent-sessions-tool-block',
		});
		const summary = details.createEl('summary', {
			cls: 'agent-sessions-tool-summary',
		});
		summary.createSpan({
			cls: 'agent-sessions-block-icon',
			text: '\u{1F527}',
		});
		summary.createSpan({ text: ` ${block.name}` });

		const content = details.createDiv({ cls: 'agent-sessions-tool-content' });
		const inputStr = this.formatToolInput(block);
		MarkdownRenderer.render(
			this.app,
			'```json\n' + inputStr + '\n```',
			content,
			'',
			this.component,
		);
	}

	private renderToolResultBlock(block: ToolResultBlock, container: HTMLElement): void {
		const details = container.createEl('details', {
			cls: `agent-sessions-result-block ${block.isError ? 'agent-sessions-result-error' : ''}`,
		});
		const summary = details.createEl('summary', {
			cls: 'agent-sessions-result-summary',
		});
		const label = block.toolName
			? `Result: ${block.toolName}`
			: 'Tool result';
		summary.createSpan({
			cls: 'agent-sessions-block-icon',
			text: block.isError ? '\u274C' : '\u2705',
		});
		summary.createSpan({ text: ` ${label}` });

		const content = details.createDiv({ cls: 'agent-sessions-result-content' });
		const resultText = block.content.length > 5000
			? block.content.substring(0, 5000) + '\n... (truncated)'
			: block.content;

		MarkdownRenderer.render(
			this.app,
			'```\n' + resultText + '\n```',
			content,
			'',
			this.component,
		);
	}

	private formatToolInput(block: ToolUseBlock): string {
		try {
			return JSON.stringify(block.input, null, 2);
		} catch {
			return String(block.input);
		}
	}
}
