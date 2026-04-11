import { App, TFolder, normalizePath } from 'obsidian';
import { diffLines } from 'diff';
import { Session, Turn, ContentBlock, ToolUseBlock, ToolResultBlock, PluginSettings } from '../types';
import { fence, langFromPath, stripLineNumbers } from '../views/render-helpers';
import { ANSI_STRIP_RE } from '../constants';

/** Accumulated images for writing to the attachment folder. */
interface PendingImage {
	fileName: string;
	data: string;  // base64
	mediaType: string;
}

export async function exportToMarkdown(
	app: App,
	session: Session,
	settings: PluginSettings
): Promise<string> {
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

	const images: PendingImage[] = [];
	const content = buildMarkdown(session, settings, safeName, images);

	// Write images to attachment subfolder if any
	if (images.length > 0) {
		const imgFolder = normalizePath(`${folder}/${safeName}`);
		const imgFolderExists = app.vault.getAbstractFileByPath(imgFolder);
		if (!imgFolderExists) {
			await app.vault.createFolder(imgFolder);
		}
		for (const img of images) {
			const imgPath = normalizePath(`${imgFolder}/${img.fileName}`);
			const bytes = base64ToBytes(img.data);
			const existingImg = app.vault.getAbstractFileByPath(imgPath);
			if (existingImg) {
				await app.vault.adapter.writeBinary(imgPath, bytes.buffer as ArrayBuffer);
			} else {
				await app.vault.createBinary(imgPath, bytes.buffer as ArrayBuffer);
			}
		}
	}

	const fileName = normalizePath(`${folder}/${safeName}.md`);
	const existingFile = app.vault.getAbstractFileByPath(fileName);
	if (existingFile) {
		await app.vault.adapter.write(fileName, content);
	} else {
		await app.vault.create(fileName, content);
	}

	return fileName;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function buildMarkdown(
	session: Session,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
): string {
	const lines: string[] = [];
	const meta = session.metadata;

	// Frontmatter
	lines.push('---');
	lines.push(`session_id: "${meta.id}"`);
	if (meta.startTime) lines.push(`date: "${meta.startTime}"`);
	if (meta.customTitle) lines.push(`title: "${meta.customTitle}"`);
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
	const displayName = meta.customTitle || meta.project;
	lines.push(`# Session: ${displayName}`);
	lines.push('');

	// Build a lookup of tool_use IDs to their blocks for pairing with results
	const toolUseMap = new Map<string, ToolUseBlock>();
	for (const turn of session.turns) {
		for (const block of turn.contentBlocks) {
			if (block.type === 'tool_use') {
				toolUseMap.set(block.id, block);
			}
		}
	}

	for (const turn of session.turns) {
		lines.push(renderTurn(turn, settings, safeName, images, toolUseMap));
		lines.push('');
	}

	return lines.join('\n');
}

function renderTurn(
	turn: Turn,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
	toolUseMap: Map<string, ToolUseBlock>,
): string {
	const lines: string[] = [];
	const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
	const timeStr = turn.timestamp ? ` (${new Date(turn.timestamp).toLocaleString()})` : '';

	lines.push(`## Turn ${turn.index + 1} — ${roleLabel}${timeStr}`);
	lines.push('');

	for (const block of turn.contentBlocks) {
		const rendered = renderBlock(block, settings, safeName, images, toolUseMap);
		if (rendered) {
			lines.push(rendered);
			lines.push('');
		}
	}

	return lines.join('\n');
}

function renderBlock(
	block: ContentBlock,
	settings: PluginSettings,
	safeName: string,
	images: PendingImage[],
	toolUseMap: Map<string, ToolUseBlock>,
): string | null {
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
			return renderToolUse(block);

		case 'tool_result':
			if (!settings.showToolResults) return null;
			return renderToolResult(block, safeName, images, toolUseMap);

		case 'image':
			return renderImage(block.mediaType, block.data, safeName, images);

		case 'ansi':
			// Strip ANSI escape codes for markdown export
			return '```\n' + block.text.replace(ANSI_STRIP_RE, '') + '\n```';

		case 'compaction':
			return '---\n*Context compacted*' + (block.summary ? `\n${block.summary}` : '') + '\n---';

		case 'slash_command':
			return [
				`> [!info]- Slash command: ${block.commandName}`,
				...block.text.split('\n').map(l => `> ${l}`),
			].join('\n');

		case 'bash_command': {
			const parts = ['```bash', block.command, '```'];
			if (block.stdout.trim()) {
				parts.push('```', block.stdout, '```');
			}
			if (block.stderr.trim()) {
				parts.push('> **stderr**', ...block.stderr.split('\n').map(l => `> ${l}`));
			}
			return parts.join('\n');
		}

		default:
			return null;
	}
}

function renderToolUse(block: ToolUseBlock): string {
	if (block.name === 'Edit') {
		return renderEditToolUse(block);
	}
	return [
		`> [!example]- Tool: ${block.name}`,
		'> ```json',
		...JSON.stringify(block.input, null, 2).split('\n').map(l => `> ${l}`),
		'> ```',
	].join('\n');
}

function renderEditToolUse(block: ToolUseBlock): string {
	const filePath = typeof block.input['file_path'] === 'string' ? block.input['file_path'] : '';
	const oldStr = typeof block.input['old_string'] === 'string' ? block.input['old_string'] : '';
	const newStr = typeof block.input['new_string'] === 'string' ? block.input['new_string'] : '';
	const replaceAll = block.input['replace_all'] ? ' (replace all)' : '';

	const changes = diffLines(oldStr, newStr);
	const outputLines: string[] = [];
	for (const change of changes) {
		const lines = change.value.replace(/\n$/, '').split('\n');
		const prefix = change.added ? '+ ' : change.removed ? '- ' : '  ';
		for (const line of lines) {
			outputLines.push(prefix + line);
		}
	}

	const header = filePath ? `Edit: ${filePath}${replaceAll}` : `Edit${replaceAll}`;
	return [
		`> [!example]- ${header}`,
		'> ```diff',
		...outputLines.map(l => `> ${l}`),
		'> ```',
	].join('\n');
}

function renderToolResult(
	block: ToolResultBlock,
	safeName: string,
	images: PendingImage[],
	toolUseMap: Map<string, ToolUseBlock>,
): string {
	const toolUse = toolUseMap.get(block.toolUseId);
	const toolName = block.toolName ?? toolUse?.name ?? '';
	const label = toolName ? `Result: ${toolName}` : 'Tool result';
	const calloutType = block.isError ? 'danger' : 'success';

	const parts: string[] = [];

	// Main text result
	if (block.content.trim()) {
		let resultText = block.content.length > 5000
			? block.content.substring(0, 5000) + '\n... (truncated)'
			: block.content;

		// For Read results: strip line numbers and use file language
		if (toolName === 'Read' && toolUse) {
			const filePath = typeof toolUse.input['file_path'] === 'string' ? toolUse.input['file_path'] : '';
			const lang = langFromPath(filePath);
			resultText = stripLineNumbers(resultText);
			parts.push(
				`> [!${calloutType}]- ${label}`,
				`> ${fence(resultText, lang).split('\n').join('\n> ')}`,
			);
		} else {
			parts.push(
				`> [!${calloutType}]- ${label}`,
				'> ```',
				...resultText.split('\n').map(l => `> ${l}`),
				'> ```',
			);
		}
	} else {
		parts.push(`> [!${calloutType}]- ${label}`);
	}

	// Inline images from tool results
	if (block.images && block.images.length > 0) {
		for (const img of block.images) {
			const ref = renderImage(img.mediaType, img.data, safeName, images);
			if (ref) parts.push('>', `> ${ref}`);
		}
	}

	return parts.join('\n');
}

function renderImage(
	mediaType: string,
	data: string,
	safeName: string,
	images: PendingImage[],
): string {
	const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
	const idx = images.length + 1;
	const fileName = `image-${idx}.${ext}`;
	images.push({ fileName, data, mediaType });
	return `![image-${idx}](${safeName}/${fileName})`;
}
