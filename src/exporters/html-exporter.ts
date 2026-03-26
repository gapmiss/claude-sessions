/**
 * HTML exporter — produces a standalone, zero-dependency HTML file
 * by snapshotting the live replay view DOM and bundling captured CSS + JS.
 */

import { Notice } from 'obsidian';
import type { Session, PluginSettings } from '../types';
import { captureAllCSS } from './css-capture';
import { getStandaloneScript } from './standalone-player';
import { shortModelName, formatElapsed } from '../views/render-helpers';

/** Additional CSS overrides for the standalone HTML context. */
const EXPORT_OVERRIDES = `
/* === Standalone Export Overrides === */
html, body {
  margin: 0;
  padding: 0;
  background: var(--background-primary);
  color: var(--text-normal);
  font-family: var(--font-interface);
}

/* Remove Obsidian viewport constraints — fill the browser window */
.agent-sessions-replay-container {
  height: auto;
  min-height: 100vh;
}

.agent-sessions-timeline {
  overflow-y: visible;
  padding-bottom: 80px;
}

/* All turns visible (no IntersectionObserver) */
.agent-sessions-turn {
  opacity: 1 !important;
}

/* Export header bar */
.as-export-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--background-modifier-border);
  font-family: var(--font-interface);
  font-size: 13px;
  color: var(--text-muted);
  flex-wrap: wrap;
  gap: 8px;
}

.as-export-header-title {
  font-weight: 600;
  color: var(--text-normal);
  font-size: 14px;
}

.as-export-header-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.as-export-header-meta span {
  white-space: nowrap;
}

/* Filter button in header */
#as-filter-btn {
  background: var(--interactive-normal);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  padding: 4px 10px;
  border-radius: var(--radius-s);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-interface);
}

#as-filter-btn:hover {
  background: var(--interactive-hover);
  color: var(--text-normal);
}

/* Filter dropdown menu */
.agent-sessions-filter-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 100;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: 8px;
  min-width: 160px;
  box-shadow: var(--shadow-s);
}

.agent-sessions-filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--text-normal);
  cursor: pointer;
  border-radius: var(--radius-s);
}

.agent-sessions-filter-row:hover {
  background: var(--background-modifier-hover);
}

.agent-sessions-filter-row.parent {
  font-weight: 600;
  margin-top: 4px;
}

.agent-sessions-filter-row.parent:first-child {
  margin-top: 0;
}

.agent-sessions-filter-row.child {
  padding-left: 22px;
}

/* Image modal overlay */
.agent-sessions-image-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agent-sessions-image-modal-container {
  max-width: 90vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.agent-sessions-image-modal-toolbar {
  display: flex;
  gap: 8px;
}

.agent-sessions-image-modal-btn {
  background: var(--interactive-normal);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-normal);
  padding: 6px 16px;
  border-radius: var(--radius-s);
  cursor: pointer;
  font-size: 13px;
  text-decoration: none;
  font-family: var(--font-interface);
}

.agent-sessions-image-modal-btn:hover {
  background: var(--interactive-hover);
}

/* Hide controls bar (playback/nav) — not applicable in export */
.agent-sessions-controls {
  display: none !important;
}

/* Copy button: ensure the SVG inline icon renders */
.agent-sessions-copy-btn,
.agent-sessions-summary-copy {
  min-width: 24px;
  min-height: 24px;
}
`;

/** Build the export header bar HTML. */
function buildHeaderHTML(session: Session): string {
	const m = session.metadata;
	const s = session.stats;
	const model = m.model ? shortModelName(m.model) : '';
	const duration = s.durationMs ? formatElapsed(s.durationMs) : '';
	const date = m.startTime
		? new Date(m.startTime).toLocaleDateString(undefined, {
			year: 'numeric', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit',
		})
		: '';

	const metaParts: string[] = [];
	if (model) metaParts.push(`<span>Model: <b>${escapeHtml(model)}</b></span>`);
	if (date) metaParts.push(`<span>${escapeHtml(date)}</span>`);
	if (duration) metaParts.push(`<span>Duration: ${escapeHtml(duration)}</span>`);
	metaParts.push(`<span>Turns: ${m.totalTurns}</span>`);

	return `<div class="as-export-header">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span class="as-export-header-title">${escapeHtml(m.project)}</span>
    <div class="as-export-header-meta">${metaParts.join('')}</div>
  </div>
  <div style="position:relative">
    <button id="as-filter-btn" aria-label="Content filters">&#x22EF; Filter</button>
  </div>
</div>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Snapshot the timeline DOM, cleaning it for standalone use.
 * Processes a deep clone so the live view is untouched.
 */
function snapshotTimeline(timelineEl: HTMLElement): string {
	const clone = timelineEl.cloneNode(true) as HTMLElement;

	// Ensure all turns are visible (remove IntersectionObserver dimming)
	clone.querySelectorAll('.agent-sessions-turn').forEach(turn => {
		(turn as HTMLElement).classList.add('visible');
	});

	// Convert SVG icons from Obsidian's setIcon() to inline SVGs
	// They're already inline SVGs in the DOM, so they'll be preserved by cloneNode

	// Add data-copy-text attributes to copy buttons that rely on JS closures
	// The live view uses addEventListener closures — we need data attributes for the standalone script
	processCopyButtons(clone, timelineEl);

	// Remove progress bar dots if present
	clone.querySelectorAll('.agent-sessions-progress-dot').forEach(el => el.remove());

	return clone.innerHTML;
}

/**
 * Copy buttons in the live view use closure-captured text.
 * We need to attach the text as data attributes for the standalone script.
 */
function processCopyButtons(clone: HTMLElement, original: HTMLElement): void {
	// Text block copy buttons — extract text from the adjacent content
	clone.querySelectorAll('.agent-sessions-text-copy').forEach(btn => {
		const wrapper = btn.closest('.agent-sessions-text-block');
		if (wrapper) {
			// Short text: content div has .agent-sessions-user-text or .agent-sessions-assistant-text
			// Long text: content is inside .agent-sessions-collapsible-content
			const contentEl = wrapper.querySelector(
				'.agent-sessions-collapsible-content, .agent-sessions-user-text, .agent-sessions-assistant-text',
			);
			if (contentEl) {
				(btn as HTMLElement).setAttribute('data-copy-text', contentEl.textContent ?? '');
				(btn as HTMLElement).classList.add('agent-sessions-copy-btn');
			}
		}
	});

	// Summary copy buttons — already have text in the adjacent value elements
	clone.querySelectorAll('.agent-sessions-summary-copy').forEach(btn => {
		const row = btn.closest('.agent-sessions-summary-id-row');
		if (row) {
			const valueEl = row.querySelector('.agent-sessions-summary-value, .agent-sessions-summary-mono');
			if (valueEl && !(btn as HTMLElement).hasAttribute('data-copy-text')) {
				(btn as HTMLElement).setAttribute('data-copy-text', valueEl.textContent ?? '');
			}
		}
	});

	// Tool result / sub-agent output copy buttons
	clone.querySelectorAll('.agent-sessions-subagent-copy').forEach(btn => {
		const output = btn.closest('.agent-sessions-subagent-output');
		if (output) {
			const content = output.querySelector('.agent-sessions-subagent-output-content');
			if (content) {
				(btn as HTMLElement).setAttribute('data-copy-text', content.textContent ?? '');
				(btn as HTMLElement).classList.add('agent-sessions-copy-btn');
			}
		}
	});

	// Code block copy buttons (Obsidian's copy-code-button)
	clone.querySelectorAll('.copy-code-button').forEach(btn => {
		const pre = btn.closest('pre');
		if (pre) {
			const code = pre.querySelector('code');
			(btn as HTMLElement).setAttribute('data-copy-text', code?.textContent ?? pre.textContent ?? '');
			(btn as HTMLElement).classList.add('agent-sessions-copy-btn');
		}
	});
}

/** Main export function: captures DOM + CSS + JS and saves as HTML file. */
export async function exportToHTML(
	timelineEl: HTMLElement,
	session: Session,
	_settings: PluginSettings,
): Promise<void> {
	const notice = new Notice('Exporting to HTML...', 0);

	try {
		// Capture CSS from the live document
		const css = captureAllCSS();

		// Snapshot the DOM
		const timelineHTML = snapshotTimeline(timelineEl);

		// Build the header
		const headerHTML = buildHeaderHTML(session);

		// Get standalone JS
		const script = getStandaloneScript();

		// Detect current theme
		const isDark = document.body.classList.contains('theme-dark');
		const themeClass = isDark ? 'theme-dark' : 'theme-light';

		// Assemble the HTML document
		const title = `Session: ${session.metadata.project}`;
		const html = `<!DOCTYPE html>
<html lang="en" class="${themeClass}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${css}

${EXPORT_OVERRIDES}
</style>
</head>
<body class="${themeClass}">
<div id="as-export-root" data-filters='{}'>
${headerHTML}
<div class="agent-sessions-replay-container">
<div class="agent-sessions-timeline markdown-rendered">
${timelineHTML}
</div>
</div>
</div>
<script>
${script}
</script>
</body>
</html>`;

		const safeName = session.metadata.id
			.replace(/[^a-zA-Z0-9_-]/g, '_')
			.substring(0, 80);

		// Try Electron save dialog first, fall back to fs write
		let savePath: string | null = null;

		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const electron = require('electron');
			const dialog = electron.remote?.dialog;
			if (dialog) {
				const result = await dialog.showSaveDialog({
					title: 'Export session as HTML',
					defaultPath: `${safeName}.html`,
					filters: [{ name: 'HTML', extensions: ['html'] }],
				});
				if (result.canceled || !result.filePath) {
					notice.hide();
					return;
				}
				savePath = result.filePath;
			}
		} catch {
			// Electron dialog unavailable
		}

		if (!savePath) {
			// Fallback: write next to the session file
			const dir = session.rawPath.replace(/[/\\][^/\\]+$/, '');
			savePath = `${dir}/${safeName}.html`;
		}

		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require('fs') as typeof import('fs');
		fs.writeFileSync(savePath, html, 'utf-8');

		notice.hide();
		new Notice(`Exported to ${savePath}`);
	} catch (e) {
		notice.hide();
		const msg = e instanceof Error ? e.message : String(e);
		new Notice(`HTML export failed: ${msg}`);
		throw e;
	}
}
