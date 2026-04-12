import { setIcon } from 'obsidian';
import type { Session, HookSuccessEvent, AsyncHookResponseEvent, SkillListingEvent, TaskReminderEvent } from '../types';
import { makeClickable } from './render-helpers';
import { basename } from '../utils/path-utils';

/**
 * Render the System Events panel (collapsible) showing hooks, skills, and task reminders.
 */
export function renderSystemEvents(session: Session, container: HTMLElement): void {
	const events = session.systemEvents;
	if (!events || events.length === 0) return;

	// Group events by type
	// Exclude events with toolUseId (shown inline with tool calls)
	const hooks = events.filter((e): e is HookSuccessEvent | AsyncHookResponseEvent =>
		(e.type === 'hook_success' && !e.toolUseId) || (e.type === 'async_hook_response' && !e.toolUseId));
	const skills = events.filter((e): e is SkillListingEvent => e.type === 'skill_listing');
	const tasks = events.filter((e): e is TaskReminderEvent => e.type === 'task_reminder' && e.itemCount > 0);

	// Don't render if nothing meaningful to show
	if (hooks.length === 0 && skills.length === 0 && tasks.length === 0) return;

	const el = container.createDiv({ cls: 'claude-sessions-system-events' });

	// Header (click to toggle)
	const header = el.createDiv({ cls: 'claude-sessions-system-events-header' });
	header.createSpan({ cls: 'claude-sessions-system-events-chevron', text: '\u25B6' });
	const icon = header.createSpan({ cls: 'claude-sessions-system-events-icon' });
	setIcon(icon, 'settings-2');
	header.createSpan({ cls: 'claude-sessions-system-events-title', text: 'System events' });

	// Inline count
	const counts: string[] = [];
	if (hooks.length > 0) counts.push(`${hooks.length} hooks`);
	if (skills.length > 0) counts.push(`${skills.length} skills`);
	if (tasks.length > 0) counts.push(`${tasks.length} tasks`);
	header.createSpan({ cls: 'claude-sessions-system-events-count', text: counts.join(', ') });

	// Body (collapsed by default)
	const body = el.createDiv({ cls: 'claude-sessions-system-events-body' });

	makeClickable(header, { label: 'Toggle system events', expanded: false });
	header.addEventListener('click', () => {
		const willOpen = !el.hasClass('open');
		el.toggleClass('open', willOpen);
		header.setAttribute('aria-expanded', String(willOpen));
	});

	// Hooks section
	if (hooks.length > 0) {
		renderHooksSection(body, hooks);
	}

	// Skills section
	if (skills.length > 0) {
		renderSkillsSection(body, skills);
	}

	// Tasks section
	if (tasks.length > 0) {
		renderTasksSection(body, tasks);
	}
}

function renderHooksSection(container: HTMLElement, hooks: (HookSuccessEvent | AsyncHookResponseEvent)[]): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'zap');
	sectionHeader.createSpan({ text: `Hooks (${hooks.length})` });

	const list = section.createDiv({ cls: 'claude-sessions-system-events-list' });

	for (const hook of hooks) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });

		// Hook name badge
		const nameParts = hook.hookName.split(':');
		const eventType = nameParts[0] || hook.hookEvent;
		const toolName = nameParts[1] || '';

		const badge = row.createSpan({ cls: 'claude-sessions-system-events-badge' });
		badge.createSpan({ cls: 'claude-sessions-system-events-badge-event', text: eventType });
		if (toolName) {
			badge.createSpan({ cls: 'claude-sessions-system-events-badge-tool', text: toolName });
		}

		// Duration (for hook_success)
		if (hook.type === 'hook_success' && hook.durationMs > 0) {
			row.createSpan({
				cls: 'claude-sessions-system-events-duration',
				text: `${hook.durationMs}ms`,
			});
		}

		// Command (shortened)
		if (hook.type === 'hook_success' && hook.command) {
			row.createSpan({
				cls: 'claude-sessions-system-events-command',
				text: basename(hook.command),
				attr: { title: hook.command },
			});
		}

		// Exit code if non-zero
		if (hook.exitCode !== 0) {
			row.createSpan({
				cls: 'claude-sessions-system-events-error',
				text: `exit ${hook.exitCode}`,
			});
		}

		// Stdout preview (collapsible if long)
		if (hook.stdout && hook.stdout.trim()) {
			const stdout = hook.stdout.trim();
			if (stdout.length > 100) {
				const preview = row.createDiv({ cls: 'claude-sessions-system-events-stdout collapsed' });
				preview.createSpan({ text: stdout.slice(0, 100) + '...' });
				const expandBtn = preview.createSpan({ cls: 'claude-sessions-system-events-expand', text: 'show more' });
				makeClickable(expandBtn, { label: 'Expand output' });
				expandBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					preview.empty();
					preview.removeClass('collapsed');
					preview.createEl('pre', { text: stdout });
				});
			} else {
				row.createDiv({ cls: 'claude-sessions-system-events-stdout', text: stdout });
			}
		}
	}
}

function renderSkillsSection(container: HTMLElement, skills: SkillListingEvent[]): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'list');
	sectionHeader.createSpan({ text: 'Available skills' });

	for (const skill of skills) {
		const content = section.createDiv({ cls: 'claude-sessions-system-events-skills' });
		// Parse skill listing content
		const lines = skill.content.split('\n').filter(l => l.trim().startsWith('- '));
		for (const line of lines) {
			const match = line.match(/^-\s+(\S+):\s*(.*)$/);
			if (match) {
				const [, name, desc] = match;
				const skillRow = content.createDiv({ cls: 'claude-sessions-system-events-skill-row' });
				skillRow.createSpan({ cls: 'claude-sessions-system-events-skill-name', text: name });
				const shortDesc = desc.length > 80 ? desc.slice(0, 80) + '...' : desc;
				skillRow.createSpan({ cls: 'claude-sessions-system-events-skill-desc', text: shortDesc });
			}
		}
	}
}

function renderTasksSection(container: HTMLElement, tasks: TaskReminderEvent[]): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'check-square');

	const totalItems = tasks.reduce((sum, t) => sum + t.itemCount, 0);
	sectionHeader.createSpan({ text: `Task reminders (${totalItems} items)` });

	// For now, just show counts since task content is often empty
	// Can expand this later to show actual task items
}
