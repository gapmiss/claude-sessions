import { App, TFolder, normalizePath } from 'obsidian';
import { Session, Turn, ContentBlock, PluginSettings } from '../types';

export async function exportToMarkdown(
	app: App,
	session: Session,
	settings: PluginSettings
): Promise<void> {
	const content = buildMarkdown(session, settings);
	const folder = normalizePath(settings.exportFolder);

	// Ensure folder exists
	const existing = app.vault.getAbstractFileByPath(folder);
	if (!existing) {
		await app.vault.createFolder(folder);
	} else if (!(existing instanceof TFolder)) {
		throw new Error(`${folder} exists but is not a folder.`);
	}

	const safeName = session.metadata.id
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.substring(0, 80);
	const fileName = normalizePath(`${folder}/${safeName}.md`);

	const existingFile = app.vault.getAbstractFileByPath(fileName);
	if (existingFile) {
		await app.vault.adapter.write(fileName, content);
	} else {
		await app.vault.create(fileName, content);
	}
}

function buildMarkdown(session: Session, settings: PluginSettings): string {
	const lines: string[] = [];
	const meta = session.metadata;

	// Frontmatter
	lines.push('---');
	lines.push(`session_id: "${meta.id}"`);
	if (meta.startTime) lines.push(`date: "${meta.startTime}"`);
	lines.push(`project: "${meta.project}"`);
	if (meta.model) lines.push(`model: "${meta.model}"`);
	if (meta.branch) lines.push(`branch: "${meta.branch}"`);
	lines.push(`format: "${meta.format}"`);
	lines.push(`total_turns: ${meta.totalTurns}`);
	if (meta.cwd) lines.push(`cwd: "${meta.cwd}"`);
	if (meta.version) lines.push(`version: "${meta.version}"`);
	lines.push('---');
	lines.push('');

	// Session header
	lines.push(`# Session: ${meta.project}`);
	lines.push('');

	for (const turn of session.turns) {
		lines.push(renderTurn(turn, settings));
		lines.push('');
	}

	return lines.join('\n');
}

function renderTurn(turn: Turn, settings: PluginSettings): string {
	const lines: string[] = [];
	const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
	const timeStr = turn.timestamp ? ` (${new Date(turn.timestamp).toLocaleString()})` : '';

	lines.push(`## Turn ${turn.index + 1} \u2014 ${roleLabel}${timeStr}`);
	lines.push('');

	for (const block of turn.contentBlocks) {
		const rendered = renderBlock(block, settings);
		if (rendered) {
			lines.push(rendered);
			lines.push('');
		}
	}

	return lines.join('\n');
}

function renderBlock(block: ContentBlock, settings: PluginSettings): string | null {
	switch (block.type) {
		case 'text':
			return block.text;

		case 'thinking':
			if (!settings.showThinkingBlocks) return null;
			return [
				'> [!note]- Thinking',
				...block.thinking.split('\n').map(l => `> ${l}`),
			].join('\n');

		case 'tool_use':
			if (!settings.showToolCalls) return null;
			return [
				`> [!example]- Tool: ${block.name}`,
				'> ```json',
				...JSON.stringify(block.input, null, 2).split('\n').map(l => `> ${l}`),
				'> ```',
			].join('\n');

		case 'tool_result': {
			if (!settings.showToolResults) return null;
			const label = block.toolName
				? `Result: ${block.toolName}`
				: 'Tool result';
			const calloutType = block.isError ? 'danger' : 'success';
			const resultText = block.content.length > 5000
				? block.content.substring(0, 5000) + '\n... (truncated)'
				: block.content;
			return [
				`> [!${calloutType}]- ${label}`,
				'> ```',
				...resultText.split('\n').map(l => `> ${l}`),
				'> ```',
			].join('\n');
		}

		default:
			return null;
	}
}
