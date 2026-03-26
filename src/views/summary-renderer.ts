import { setIcon } from 'obsidian';
import type { Session } from '../types';
import { type RenderContext, makeClickable, addCopyButton } from './render-helpers';

/** Render the session summary panel (collapsible) above the timeline. */
export function renderSummary(session: Session, container: HTMLElement, ctx: RenderContext): void {
	const el = container.createDiv({ cls: 'agent-sessions-summary' });
	const { metadata, stats } = session;

	// Header (click to toggle)
	const header = el.createDiv({ cls: 'agent-sessions-summary-header' });
	header.createSpan({ cls: 'agent-sessions-summary-chevron', text: '\u25B6' });
	const icon = header.createSpan({ cls: 'agent-sessions-summary-icon' });
	setIcon(icon, 'bar-chart-2');
	header.createSpan({ cls: 'agent-sessions-summary-title', text: 'Session summary' });

	// Inline stats in header: context window size, cost, turns
	if (stats.contextWindowTokens > 0) {
		header.createSpan({
			cls: 'agent-sessions-summary-inline',
			text: `${formatTokens(stats.contextWindowTokens)} context`,
		});
	}
	if (stats.costUSD > 0) {
		header.createSpan({
			cls: 'agent-sessions-summary-inline',
			text: formatCost(stats.costUSD),
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

	makeClickable(header, { label: 'Toggle session summary', expanded: false });
	header.addEventListener('click', () => {
		const willOpen = !el.hasClass('open');
		el.toggleClass('open', willOpen);
		header.setAttribute('aria-expanded', String(willOpen));
	});

	// --- Session ID ---
	const idSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
	idSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Session ID' });
	const idRow = idSection.createDiv({ cls: 'agent-sessions-summary-id-row' });
	idRow.createSpan({ cls: 'agent-sessions-summary-value agent-sessions-summary-mono', text: metadata.id });
	addCopyButton(idRow, metadata.id, 'Copy session ID');
	addCopyButton(idRow, session.rawPath, 'Copy file path');

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
	addCopyButton(uriRow, obsidianUri, 'Copy URI');
	addCopyButton(uriRow, mdLink, 'Copy markdown link');

	// --- Metadata grid ---
	const grid = body.createDiv({ cls: 'agent-sessions-summary-grid' });

	if (metadata.project) addGridItem(grid, 'Project', metadata.project);
	if (metadata.model) addGridItem(grid, 'Model', metadata.model);
	if (metadata.version) addGridItem(grid, 'Version', metadata.version);
	if (metadata.branch) addGridItem(grid, 'Branch', metadata.branch);
	if (metadata.cwd) addGridItem(grid, 'Working dir', metadata.cwd);
	if (metadata.startTime) {
		const d = new Date(metadata.startTime);
		addGridItem(grid, 'Started', d.toLocaleString());
	}
	if (stats.durationMs > 0) {
		addGridItem(grid, 'Duration', formatDuration(stats.durationMs));
	}

	// --- Turns ---
	const turnsSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
	turnsSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Turns' });
	const turnsGrid = turnsSection.createDiv({ cls: 'agent-sessions-summary-grid' });
	addGridItem(turnsGrid, 'User', String(stats.userTurns));
	addGridItem(turnsGrid, 'Assistant', String(stats.assistantTurns));
	addGridItem(turnsGrid, 'Total', String(metadata.totalTurns));

	// --- Context & Cost ---
	if (stats.contextWindowTokens > 0 || stats.costUSD > 0) {
		const ctxSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
		ctxSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Context & cost' });
		const ctxGrid = ctxSection.createDiv({ cls: 'agent-sessions-summary-grid' });
		if (stats.contextWindowTokens > 0) {
			addGridItem(ctxGrid, 'Context window', formatTokens(stats.contextWindowTokens));
		}
		if (stats.costUSD > 0) {
			addGridItem(ctxGrid, 'Estimated cost', formatCost(stats.costUSD));
		}
	}

	// --- Token usage (cumulative) ---
	const totalInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
	if (totalInput > 0 || stats.outputTokens > 0) {
		const tokenSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
		tokenSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'API usage (cumulative)' });
		const tokenGrid = tokenSection.createDiv({ cls: 'agent-sessions-summary-grid' });
		addGridItem(tokenGrid, 'Input (total)', formatTokens(totalInput));
		addGridItem(tokenGrid, 'Output', formatTokens(stats.outputTokens));
		if (stats.cacheReadTokens > 0) {
			addGridItem(tokenGrid, 'Cache read', formatTokens(stats.cacheReadTokens));
		}
		if (stats.cacheCreationTokens > 0) {
			addGridItem(tokenGrid, 'Cache write', formatTokens(stats.cacheCreationTokens));
		}
		if (stats.inputTokens > 0) {
			addGridItem(tokenGrid, 'Uncached', formatTokens(stats.inputTokens));
		}
	}

	// --- Tool usage ---
	const toolNames = Object.keys(stats.toolUseCounts);
	if (toolNames.length > 0) {
		const toolSection = body.createDiv({ cls: 'agent-sessions-summary-section' });
		toolSection.createDiv({ cls: 'agent-sessions-summary-label', text: 'Tool usage' });
		const toolGrid = toolSection.createDiv({ cls: 'agent-sessions-summary-grid' });
		toolNames
			.sort((a, b) => stats.toolUseCounts[b] - stats.toolUseCounts[a])
			.forEach(name => {
				addGridItem(toolGrid, name, String(stats.toolUseCounts[name]));
			});
	}

	void ctx; // ctx reserved for future use (e.g. markdown rendering in summary)
}

function addGridItem(grid: HTMLElement, label: string, value: string): void {
	grid.createSpan({ cls: 'agent-sessions-summary-grid-label', text: label });
	grid.createSpan({ cls: 'agent-sessions-summary-grid-value', text: value });
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
	return String(n);
}

function formatCost(usd: number): string {
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	return `$${usd.toFixed(3)}`;
}

function formatDuration(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}
