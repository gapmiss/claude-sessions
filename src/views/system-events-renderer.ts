import { setIcon } from 'obsidian';
import type {
	Session, HookSuccessEvent, AsyncHookResponseEvent, SkillListingEvent, TaskReminderEvent,
	OutputStyleEvent, CommandPermissionsEvent, HookNonBlockingErrorEvent, PermissionModeEvent,
} from '../types';
import { makeClickable, shortHookCommand, summarizeStopHooks, type StopHookSummary } from './render-helpers';

/** Format a count with its noun, pluralized. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Render the collapsible System events panel: output style, permission mode,
 * command permissions, hooks, skills, and task reminders.
 */
export function renderSystemEvents(session: Session, container: HTMLElement): void {
	const events = session.systemEvents;
	if (!events || events.length === 0) return;

	// Group events by type.
	// A tool-scoped event belongs inline only when its toolUseId actually names a
	// tool call in this session. A turn-level hook such as Stop carries a
	// toolUseID that matches nothing, so testing for the field's presence alone
	// dropped those events from both places and rendered them nowhere.
	const toolUseIds = new Set<string>();
	for (const turn of session.turns) {
		for (const block of turn.contentBlocks) {
			if (block.type === 'tool_use') toolUseIds.add(block.id);
		}
	}
	const isInline = (e: { toolUseId?: string }): boolean => Boolean(e.toolUseId && toolUseIds.has(e.toolUseId));

	const hooks = events.filter((e): e is HookSuccessEvent | AsyncHookResponseEvent =>
		(e.type === 'hook_success' || e.type === 'async_hook_response') && !isInline(e));
	const skills = events.filter((e): e is SkillListingEvent => e.type === 'skill_listing');
	const tasks = events.filter((e): e is TaskReminderEvent => e.type === 'task_reminder' && e.itemCount > 0);
	const styles = events.filter((e): e is OutputStyleEvent => e.type === 'output_style');
	const grants = events.filter((e): e is CommandPermissionsEvent => e.type === 'command_permissions');
	// hook_non_blocking_error carries the full hook_success field set, so it joins
	// the HOOKS section when it isn't already shown inline on a tool call.
	const hookErrors = events.filter((e): e is HookNonBlockingErrorEvent =>
		e.type === 'hook_non_blocking_error' && !isInline(e));
	const modes = events.filter((e): e is PermissionModeEvent => e.type === 'permission-mode');
	const stopHooks = summarizeStopHooks(events);

	// Don't render if nothing meaningful to show
	if (hooks.length === 0 && skills.length === 0 && tasks.length === 0 && styles.length === 0
		&& grants.length === 0 && hookErrors.length === 0 && modes.length === 0 && stopHooks.totalRuns === 0) return;

	const el = container.createDiv({ cls: 'claude-sessions-system-events' });

	// Header (click to toggle)
	const header = el.createDiv({ cls: 'claude-sessions-system-events-header' });
	header.createSpan({ cls: 'claude-sessions-system-events-chevron', text: '\u25B6' });
	const icon = header.createSpan({ cls: 'claude-sessions-system-events-icon' });
	setIcon(icon, 'settings-2');
	header.createSpan({ cls: 'claude-sessions-system-events-title', text: 'System events' });

	// Inline count. Skills and tasks count the items inside their listing
	// records, not the records themselves. One skill_listing can carry many.
	const skillCount = skills.reduce((sum, s) => sum + s.skillCount, 0);
	const taskCount = tasks.reduce((sum, t) => sum + t.itemCount, 0);

	const counts: string[] = [];
	if (styles.length > 0) counts.push(styles[styles.length - 1].style);
	if (modes.length > 1) counts.push(plural(modes.length - 1, 'mode change'));
	const hookRuns = hooks.length + hookErrors.length + stopHooks.totalRuns;
	if (hookRuns > 0) counts.push(plural(hookRuns, 'hook'));
	if (skillCount > 0) counts.push(plural(skillCount, 'skill'));
	if (taskCount > 0) counts.push(plural(taskCount, 'task'));
	if (grants.length > 0) counts.push(plural(grants.length, 'grant'));
	header.createSpan({ cls: 'claude-sessions-system-events-count', text: counts.join(', ') });

	// Body (collapsed by default)
	const body = el.createDiv({ cls: 'claude-sessions-system-events-body' });

	makeClickable(header, { label: 'Toggle system events', expanded: false });
	header.addEventListener('click', () => {
		const willOpen = !el.hasClass('open');
		el.toggleClass('open', willOpen);
		header.setAttribute('aria-expanded', String(willOpen));
	});

	// Output style section
	if (styles.length > 0) {
		renderOutputStyleSection(body, styles);
	}

	// Permission mode section
	if (modes.length > 0) {
		renderPermissionModeSection(body, modes);
	}

	// Command permissions section
	if (grants.length > 0) {
		renderCommandPermissionsSection(body, grants);
	}

	// Hooks section
	if (hookRuns > 0) {
		renderHooksSection(body, [...hooks, ...hookErrors], stopHooks);
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

function renderOutputStyleSection(container: HTMLElement, styles: OutputStyleEvent[]): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'pen-line');
	// More than one event means the style changed partway through the session.
	sectionHeader.createSpan({ text: styles.length > 1 ? `Output style (${styles.length} changes)` : 'Output style' });

	const list = section.createDiv({ cls: 'claude-sessions-system-events-list' });
	for (const style of styles) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });
		const badge = row.createSpan({ cls: 'claude-sessions-system-events-badge' });
		// Dedicated class: output style names are user-authored, so preserve their
		// exact casing rather than uppercasing them like hook event names.
		badge.createSpan({
			cls: 'claude-sessions-system-events-badge-event claude-sessions-system-events-badge-style',
			text: style.style,
		});
		if (styles.length > 1 && style.timestamp) {
			row.createSpan({
				cls: 'claude-sessions-system-events-duration',
				text: new Date(style.timestamp).toLocaleTimeString(),
			});
		}
	}
}

function renderPermissionModeSection(container: HTMLElement, modes: PermissionModeEvent[]): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'lock-keyhole');
	sectionHeader.createSpan({ text: modes.length > 1 ? `Permission mode (${plural(modes.length - 1, 'change')})` : 'Permission mode' });

	const list = section.createDiv({ cls: 'claude-sessions-system-events-list' });
	for (const mode of modes) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });
		const badge = row.createSpan({ cls: 'claude-sessions-system-events-badge' });
		// Mode names are camelCase identifiers (acceptEdits), so keep their casing.
		badge.createSpan({
			cls: 'claude-sessions-system-events-badge-event claude-sessions-system-events-badge-style',
			text: mode.permissionMode,
		});
		row.createSpan({
			cls: 'claude-sessions-system-events-duration',
			text: mode.turnIndex === 0 ? 'from the start' : `from turn ${mode.turnIndex + 1}`,
		});
	}
}

function renderCommandPermissionsSection(container: HTMLElement, grants: CommandPermissionsEvent[]): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'shield-check');
	sectionHeader.createSpan({ text: 'Command permissions' });

	const list = section.createDiv({ cls: 'claude-sessions-system-events-list' });
	for (const grant of grants) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });
		if (grant.commandName) {
			row.createSpan({
				cls: 'claude-sessions-system-events-skill-name',
				text: grant.commandName,
			});
		}
		for (const tool of grant.allowedTools) {
			row.createSpan({
				cls: 'claude-sessions-system-events-badge-event claude-sessions-system-events-badge-style',
				text: tool,
			});
		}
	}
}

type HookRow = HookSuccessEvent | AsyncHookResponseEvent | HookNonBlockingErrorEvent;

function renderHooksSection(container: HTMLElement, hooks: HookRow[], stopHooks: StopHookSummary): void {
	const section = container.createDiv({ cls: 'claude-sessions-system-events-section' });
	const sectionHeader = section.createDiv({ cls: 'claude-sessions-system-events-section-header' });
	const headerIcon = sectionHeader.createSpan({ cls: 'claude-sessions-system-events-section-icon' });
	setIcon(headerIcon, 'zap');
	sectionHeader.createSpan({ text: `Hooks (${hooks.length + stopHooks.totalRuns})` });

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

		// Duration (hook_success and hook_non_blocking_error carry the same fields)
		if (hook.type !== 'async_hook_response' && hook.durationMs > 0) {
			row.createSpan({
				cls: 'claude-sessions-system-events-duration',
				text: `${hook.durationMs}ms`,
			});
		}

		// Command (shortened)
		if (hook.type !== 'async_hook_response' && hook.command) {
			row.createSpan({
				cls: 'claude-sessions-system-events-command',
				text: shortHookCommand(hook.command),
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

	renderStopHookRows(list, stopHooks);
}

/** One row per Stop hook command, then any errors and blocked stops. */
function renderStopHookRows(list: HTMLElement, stopHooks: StopHookSummary): void {
	for (const group of stopHooks.groups) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });
		const badge = row.createSpan({ cls: 'claude-sessions-system-events-badge' });
		badge.createSpan({ cls: 'claude-sessions-system-events-badge-event', text: 'Stop' });
		row.createSpan({ cls: 'claude-sessions-system-events-duration', text: plural(group.runs, 'run') });
		if (group.avgMs !== undefined) {
			row.createSpan({ cls: 'claude-sessions-system-events-duration', text: `avg ${group.avgMs}ms` });
		}
		if (group.command) {
			row.createSpan({
				cls: 'claude-sessions-system-events-command',
				text: shortHookCommand(group.command),
				attr: { title: group.command },
			});
		}
	}

	for (const error of stopHooks.errors) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });
		const badge = row.createSpan({ cls: 'claude-sessions-system-events-badge' });
		badge.createSpan({ cls: 'claude-sessions-system-events-badge-event', text: 'Stop' });
		row.createSpan({
			cls: 'claude-sessions-system-events-error',
			text: error.count > 1 ? `error, ${error.count} times` : 'error',
		});
		row.createDiv({ cls: 'claude-sessions-system-events-stdout', text: error.message });
	}

	if (stopHooks.preventedCount > 0) {
		const row = list.createDiv({ cls: 'claude-sessions-system-events-row' });
		const badge = row.createSpan({ cls: 'claude-sessions-system-events-badge' });
		badge.createSpan({ cls: 'claude-sessions-system-events-badge-event', text: 'Stop' });
		row.createSpan({
			cls: 'claude-sessions-system-events-error',
			text: `kept Claude working ${stopHooks.preventedCount === 1 ? 'once' : `${stopHooks.preventedCount} times`}`,
		});
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
	sectionHeader.createSpan({ text: `Task reminders (${plural(totalItems, 'item')})` });

	// For now, just show counts since task content is often empty
	// Can expand this later to show actual task items
}
