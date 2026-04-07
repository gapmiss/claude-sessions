import { setIcon } from 'obsidian';
import type { Session, SessionMetadata, SessionStats } from '../types';
import { type RenderContext, makeClickable, addCopyButton } from './render-helpers';
import { fetchRateLimits, type RateLimitData } from '../utils/rate-limits';

/** Render the session summary panel (collapsible) above the timeline. */
export function renderSummary(session: Session, container: HTMLElement, ctx: RenderContext): void {
	const { metadata, stats } = session;

	// Pinned heroes bar — direct child of scroll container for position:sticky
	const pinnedHeroes = container.createDiv({ cls: 'claude-sessions-pinned-heroes' });
	buildHeroCards(pinnedHeroes, stats, metadata, null);

	const unpinBtn = pinnedHeroes.createEl('button', {
		cls: 'claude-sessions-heroes-pin clickable-icon is-active',
		attr: {
			'aria-label': 'Click to unpin stats',
			'data-tooltip-position': 'bottom',
		},
	});
	setIcon(unpinBtn, 'pin');

	const el = container.createDiv({ cls: 'claude-sessions-summary' });

	// Header (click to toggle)
	const header = el.createDiv({ cls: 'claude-sessions-summary-header' });
	header.createSpan({ cls: 'claude-sessions-summary-chevron', text: '\u25B6' });
	const icon = header.createSpan({ cls: 'claude-sessions-summary-icon' });
	setIcon(icon, 'bar-chart-2');
	header.createSpan({ cls: 'claude-sessions-summary-title', text: 'Session summary' });

	// Inline stats in header: context window size, cost, turns
	if (stats.contextWindowTokens > 0) {
		header.createSpan({
			cls: 'claude-sessions-summary-inline',
			text: `${formatTokens(stats.contextWindowTokens)} context`,
		});
	}
	if (stats.costUSD > 0) {
		header.createSpan({
			cls: 'claude-sessions-summary-inline',
			text: formatCost(stats.costUSD),
		});
	}
	if (metadata.totalTurns > 0) {
		header.createSpan({
			cls: 'claude-sessions-summary-inline',
			text: `${metadata.totalTurns} turns`,
		});
	}

	// Body (collapsed by default)
	const body = el.createDiv({ cls: 'claude-sessions-summary-body' });

	makeClickable(header, { label: 'Toggle session summary', expanded: false });
	header.addEventListener('click', () => {
		const willOpen = !el.hasClass('open');
		el.toggleClass('open', willOpen);
		header.setAttribute('aria-expanded', String(willOpen));
	});

	// ═══════════════════════════════════════
	// Hero stat cards (with pin button)
	// ═══════════════════════════════════════
	const heroes = body.createDiv({ cls: 'claude-sessions-dash-heroes' });
	buildHeroCards(heroes, stats, metadata, null);

	const pinBtn = heroes.createEl('button', {
		cls: 'claude-sessions-heroes-pin clickable-icon',
		attr: {
			'aria-label': 'Click to pin stats to top',
			'data-tooltip-position': 'top',
		},
	});
	setIcon(pinBtn, 'pin');
	const togglePin = (willPin: boolean) => {
		pinnedHeroes.toggleClass('is-pinned', willPin);
		pinBtn.toggleClass('is-active', willPin);
		pinBtn.setAttribute('aria-label', willPin ? 'Click to unpin stats' : 'Click to pin stats to top');
	};

	pinBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		togglePin(!pinnedHeroes.hasClass('is-pinned'));
	});

	unpinBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		togglePin(false);
	});

	// ═══════════════════════════════════════
	// Two-column layout for charts
	// ═══════════════════════════════════════
	const charts = body.createDiv({ cls: 'claude-sessions-dash-charts' });

	// --- Token usage chart ---
	const totalInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
	if (totalInput > 0 || stats.outputTokens > 0) {
		const tokenCard = charts.createDiv({ cls: 'claude-sessions-dash-card' });
		tokenCard.createDiv({ cls: 'claude-sessions-dash-card-title', text: 'Token usage' });

		// Input stacked bar
		if (totalInput > 0) {
			const inputRow = tokenCard.createDiv({ cls: 'claude-sessions-dash-bar-row' });
			inputRow.createSpan({ cls: 'claude-sessions-dash-bar-label', text: 'Input' });
			inputRow.createSpan({ cls: 'claude-sessions-dash-bar-value', text: formatTokens(totalInput) });

			const barTrack = tokenCard.createDiv({ cls: 'claude-sessions-dash-stacked-track' });
			const segments: { value: number; cls: string; label: string }[] = [];
			if (stats.cacheReadTokens > 0) {
				segments.push({ value: stats.cacheReadTokens, cls: 'cache-read', label: `Cache read ${formatTokens(stats.cacheReadTokens)}` });
			}
			if (stats.cacheCreationTokens > 0) {
				segments.push({ value: stats.cacheCreationTokens, cls: 'cache-write', label: `Cache write ${formatTokens(stats.cacheCreationTokens)}` });
			}
			if (stats.inputTokens > 0) {
				segments.push({ value: stats.inputTokens, cls: 'uncached', label: `Uncached ${formatTokens(stats.inputTokens)}` });
			}
			for (const seg of segments) {
				const pct = (seg.value / totalInput) * 100;
				const segEl = barTrack.createDiv({ cls: `claude-sessions-dash-stacked-seg ${seg.cls}` });
				segEl.style.width = `${Math.max(pct, 1)}%`;
				segEl.setAttribute('aria-label', seg.label);
				segEl.setAttribute('data-tooltip-position', 'top');
			}

			// Legend
			const legend = tokenCard.createDiv({ cls: 'claude-sessions-dash-legend' });
			if (stats.cacheReadTokens > 0) addLegendItem(legend, 'cache-read', 'Cache read', formatTokens(stats.cacheReadTokens));
			if (stats.cacheCreationTokens > 0) addLegendItem(legend, 'cache-write', 'Cache write', formatTokens(stats.cacheCreationTokens));
			if (stats.inputTokens > 0) addLegendItem(legend, 'uncached', 'Uncached', formatTokens(stats.inputTokens));
		}

		// Output row
		if (stats.outputTokens > 0) {
			const outputRow = tokenCard.createDiv({ cls: 'claude-sessions-dash-bar-row claude-sessions-dash-output-row' });
			outputRow.createSpan({ cls: 'claude-sessions-dash-bar-label', text: 'Output' });
			outputRow.createSpan({ cls: 'claude-sessions-dash-bar-value', text: formatTokens(stats.outputTokens) });

			// Output bar (relative to total input for visual comparison)
			if (totalInput > 0) {
				const outTrack = tokenCard.createDiv({ cls: 'claude-sessions-dash-stacked-track' });
				const outPct = Math.min((stats.outputTokens / totalInput) * 100, 100);
				const outSeg = outTrack.createDiv({ cls: 'claude-sessions-dash-stacked-seg output' });
				outSeg.style.width = `${Math.max(outPct, 1)}%`;
			}
		}
	}

	// --- Tool usage chart ---
	renderToolChart(stats, charts);

	// ═══════════════════════════════════════
	// Metadata card
	// ═══════════════════════════════════════
	const metaCard = body.createDiv({ cls: 'claude-sessions-dash-card claude-sessions-dash-meta' });
	metaCard.createDiv({ cls: 'claude-sessions-dash-card-title', text: 'Session details' });

	const metaGrid = metaCard.createDiv({ cls: 'claude-sessions-dash-meta-grid' });

	if (metadata.project) addMetaItem(metaGrid, 'Project', metadata.project);
	if (metadata.model) addMetaItem(metaGrid, 'Model', metadata.model);
	if (metadata.version) addMetaItem(metaGrid, 'Version', metadata.version);
	if (metadata.branch) addMetaItem(metaGrid, 'Branch', metadata.branch);
	if (metadata.startTime) {
		const d = new Date(metadata.startTime);
		addMetaItem(metaGrid, 'Started', d.toLocaleString());
	}
	if (stats.durationMs > 0) addMetaItem(metaGrid, 'Duration', formatDuration(stats.durationMs));
	if (metadata.cwd) addMetaItem(metaGrid, 'Working dir', metadata.cwd, true);

	// Turn breakdown
	if (stats.userTurns > 0 || stats.assistantTurns > 0) {
		const turnRow = metaCard.createDiv({ cls: 'claude-sessions-dash-turn-breakdown' });
		turnRow.createSpan({ cls: 'claude-sessions-dash-turn-item', text: `${stats.userTurns} user` });
		turnRow.createSpan({ cls: 'claude-sessions-dash-turn-sep', text: '/' });
		turnRow.createSpan({ cls: 'claude-sessions-dash-turn-item', text: `${stats.assistantTurns} assistant` });
		turnRow.createSpan({ cls: 'claude-sessions-dash-turn-sep', text: '=' });
		turnRow.createSpan({ cls: 'claude-sessions-dash-turn-item claude-sessions-dash-turn-total', text: `${metadata.totalTurns} turns` });
	}

	// ═══════════════════════════════════════
	// Session ID & URI (compact, at bottom)
	// ═══════════════════════════════════════
	const idSection = body.createDiv({ cls: 'claude-sessions-dash-ids' });

	const idRow = idSection.createDiv({ cls: 'claude-sessions-dash-id-row' });
	idRow.createSpan({ cls: 'claude-sessions-dash-id-label', text: 'ID' });
	idRow.createSpan({ cls: 'claude-sessions-dash-id-value', text: metadata.id });
	addCopyButton(idRow, metadata.id, 'Copy session ID');
	addCopyButton(idRow, session.rawPath, 'Copy file path');

	const resumeCmd = `claude --resume ${metadata.id}`;
	const resumeRow = idSection.createDiv({ cls: 'claude-sessions-dash-id-row' });
	resumeRow.createSpan({ cls: 'claude-sessions-dash-id-label', text: 'Resume' });
	resumeRow.createSpan({ cls: 'claude-sessions-dash-id-value', text: resumeCmd });
	addCopyButton(resumeRow, resumeCmd, 'Copy resume command');

	const obsidianUri = `obsidian://claude-sessions?session=${encodeURIComponent(session.rawPath)}`;
	const mdLink = `[${metadata.project} session](${obsidianUri})`;
	const uriRow = idSection.createDiv({ cls: 'claude-sessions-dash-id-row' });
	uriRow.createSpan({ cls: 'claude-sessions-dash-id-label', text: 'URI' });
	const uriPreview = obsidianUri.length > 50
		? obsidianUri.substring(0, 50) + '\u2026'
		: obsidianUri;
	uriRow.createSpan({ cls: 'claude-sessions-dash-id-value', text: uriPreview });
	addCopyButton(uriRow, obsidianUri, 'Copy URI');
	addCopyButton(uriRow, mdLink, 'Copy markdown link');

	// Async: fetch rate limits and inject hero cards
	if (ctx.settings.showRateLimits) {
		void fetchRateLimits().then(rl => {
			if (!rl) return;
			appendRateLimitCards(pinnedHeroes, rl);
			appendRateLimitCards(heroes, rl);
		});
	}
}

// ═══════════════════════════════════════
// Component helpers
// ═══════════════════════════════════════

function buildHeroCards(container: HTMLElement, stats: SessionStats, metadata: SessionMetadata, _rl: RateLimitData | null): void {
	if (stats.costUSD > 0) addHeroCard(container, formatCost(stats.costUSD), 'Cost', 'receipt');
	if (stats.contextWindowTokens > 0) addHeroCard(container, formatTokens(stats.contextWindowTokens), 'Context', 'layers');
	if (metadata.totalTurns > 0) addHeroCard(container, String(metadata.totalTurns), 'Turns', 'message-circle');
	if (stats.durationMs > 0) addHeroCard(container, formatDuration(stats.durationMs), 'Duration', 'clock');
}

function appendRateLimitCards(container: HTMLElement, rl: RateLimitData): void {
	if (rl.fiveHourPercent != null) {
		addRateLimitCard(container, rl.fiveHourPercent, '5h limit', 'gauge', rl.fiveHourResetsAt);
	}
	if (rl.weeklyPercent != null) {
		addRateLimitCard(container, rl.weeklyPercent, '7d limit', 'calendar-clock', rl.weeklyResetsAt);
	}
}

function addRateLimitCard(container: HTMLElement, percent: number, label: string, iconName: string, resetsAt: string | null): void {
	const card = container.createDiv({ cls: 'claude-sessions-dash-hero claude-sessions-dash-hero-rate' });
	const iconEl = card.createDiv({ cls: 'claude-sessions-dash-hero-icon' });
	setIcon(iconEl, iconName);
	card.createDiv({ cls: 'claude-sessions-dash-hero-value', text: `${Math.round(percent)}%` });

	// Mini progress bar
	const track = card.createDiv({ cls: 'claude-sessions-dash-hero-bar-track' });
	const fill = track.createDiv({ cls: 'claude-sessions-dash-hero-bar-fill' });
	fill.style.width = `${Math.min(percent, 100)}%`;
	if (percent >= 90) fill.addClass('critical');
	else if (percent >= 70) fill.addClass('warning');

	// Reset time below bar
	if (resetsAt) {
		const resetDate = new Date(resetsAt);
		const exactLabel = resetDate.toLocaleDateString(undefined, {
			weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
		});
		card.createDiv({
			cls: 'claude-sessions-dash-hero-reset',
			text: `Resets ${formatRelativeTime(resetDate)}`,
			attr: { 'aria-label': exactLabel, 'data-tooltip-position': 'bottom' },
		});
	}
}

function addHeroCard(container: HTMLElement, value: string, label: string, iconName: string): void {
	const card = container.createDiv({ cls: 'claude-sessions-dash-hero' });
	const iconEl = card.createDiv({ cls: 'claude-sessions-dash-hero-icon' });
	setIcon(iconEl, iconName);
	card.createDiv({ cls: 'claude-sessions-dash-hero-value', text: value });
	card.createDiv({ cls: 'claude-sessions-dash-hero-label', text: label });
}

function addLegendItem(container: HTMLElement, cls: string, label: string, value: string): void {
	const item = container.createDiv({ cls: 'claude-sessions-dash-legend-item' });
	item.createSpan({ cls: `claude-sessions-dash-legend-dot ${cls}` });
	item.createSpan({ text: label });
	item.createSpan({ cls: 'claude-sessions-dash-legend-value', text: value });
}

function addMetaItem(grid: HTMLElement, label: string, value: string, fullWidth?: boolean): void {
	const item = grid.createDiv({ cls: 'claude-sessions-dash-meta-item' + (fullWidth ? ' full-width' : '') });
	item.createSpan({ cls: 'claude-sessions-dash-meta-label', text: label });
	item.createSpan({ cls: 'claude-sessions-dash-meta-value', text: value });
}

function renderToolChart(stats: SessionStats, container: HTMLElement): void {
	const toolNames = Object.keys(stats.toolUseCounts);
	if (toolNames.length === 0) return;

	const toolCard = container.createDiv({ cls: 'claude-sessions-dash-card' });
	toolCard.createDiv({ cls: 'claude-sessions-dash-card-title', text: 'Tool usage' });

	const sorted = toolNames.sort((a, b) => stats.toolUseCounts[b] - stats.toolUseCounts[a]);
	const maxCount = stats.toolUseCounts[sorted[0]];
	const totalCalls = sorted.reduce((sum, n) => sum + stats.toolUseCounts[n], 0);

	// Total count
	toolCard.createDiv({ cls: 'claude-sessions-dash-tool-total', text: `${totalCalls} total calls` });

	const bars = toolCard.createDiv({ cls: 'claude-sessions-dash-tool-bars' });
	for (const name of sorted) {
		const count = stats.toolUseCounts[name];
		const pct = (count / maxCount) * 100;

		const row = bars.createDiv({ cls: 'claude-sessions-dash-tool-row' });
		row.createSpan({ cls: 'claude-sessions-dash-tool-name', text: name });
		const barWrap = row.createDiv({ cls: 'claude-sessions-dash-tool-bar-wrap' });
		const bar = barWrap.createDiv({ cls: 'claude-sessions-dash-tool-bar' });
		bar.style.width = `${Math.max(pct, 2)}%`;
		row.createSpan({ cls: 'claude-sessions-dash-tool-count', text: String(count) });
	}
}

// ═══════════════════════════════════════
// Formatters
// ═══════════════════════════════════════

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

function formatRelativeTime(date: Date): string {
	const now = Date.now();
	const diffMs = date.getTime() - now;
	const absDiffMs = Math.abs(diffMs);
	const inFuture = diffMs > 0;

	const minutes = Math.round(absDiffMs / 60_000);

	let relative: string;
	if (minutes < 1) relative = 'now';
	else if (minutes < 60) relative = `${minutes}m`;
	else if (absDiffMs < 86_400_000) {
		const h = Math.floor(absDiffMs / 3_600_000);
		const m = Math.round((absDiffMs % 3_600_000) / 60_000);
		relative = m > 0 ? `${h}h ${m}m` : `${h}h`;
	} else {
		const d = Math.floor(absDiffMs / 86_400_000);
		const h = Math.round((absDiffMs % 86_400_000) / 3_600_000);
		relative = h > 0 ? `${d}d ${h}h` : `${d}d`;
	}

	if (relative === 'now') return relative;
	return inFuture ? `in ${relative}` : `${relative} ago`;
}
