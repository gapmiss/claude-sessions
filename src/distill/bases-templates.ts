/**
 * Embedded Obsidian Bases (.base) templates for session dashboards.
 * These are shipped with the plugin and installed via command.
 */

import { App, TFolder, normalizePath } from 'obsidian';

/**
 * Template definition with name and content.
 */
interface BasesTemplate {
	name: string;
	fileName: string;
	content: string;
}

/**
 * All available Bases templates.
 */
export const BASES_TEMPLATES: BasesTemplate[] = [
	{
		name: 'Session Dashboard',
		fileName: 'Session Dashboard.base',
		content: `filters:
  file.hasTag("claude-session")
formulas:
  cost_display: 'if(cost_usd, "$" + cost_usd.toFixed(2), "")'
  tokens_k: '((input_tokens + output_tokens) / 1000).round(0)'
views:
  - type: table
    name: "All Sessions"
    order: [project, file.name, formula.cost_display, formula.tokens_k, duration_min, model, session_type]
    summaries:
      cost_usd: Sum
      duration_min: Sum
`,
	},
	{
		name: 'Cost Tracker',
		fileName: 'Cost Tracker.base',
		content: `filters:
  file.hasTag("claude-session")
formulas:
  cost_display: 'if(cost_usd, "$" + cost_usd.toFixed(2), "")'
views:
  - type: table
    name: "By Project"
    order: [project, formula.cost_display, input_tokens, output_tokens, cache_read_tokens, model]
    groupBy:
      property: project
      direction: ASC
    summaries:
      cost_usd: Sum
`,
	},
	{
		name: 'Recent Sessions',
		fileName: 'Recent Sessions.base',
		content: `filters:
  and:
    - file.hasTag("claude-session")
    - '(now() - date(start_time)).days <= 7'
views:
  - type: table
    name: "Last 7 Days"
    order: [project, file.name, start_time, duration_min, cost_usd, session_type]
`,
	},
	{
		name: 'Error Patterns',
		fileName: 'Error Patterns.base',
		content: `filters:
  and:
    - file.hasTag("claude-session")
    - 'error_count > 0'
views:
  - type: table
    name: "Sessions with Errors"
    order: [project, file.name, error_count, start_time, session_type]
`,
	},
];

/**
 * Result of installing Bases templates.
 */
export interface InstallTemplatesResult {
	installed: string[];
	skipped: string[];
	failed: { name: string; error: string }[];
}

/**
 * Install Bases templates to the vault.
 * Skips templates that already exist (unless force=true).
 *
 * @param app Obsidian App instance
 * @param basesFolder Path to install templates (e.g., 'Claude sessions/bases')
 * @param force Overwrite existing templates
 */
export async function installBasesTemplates(
	app: App,
	basesFolder: string,
	force = false
): Promise<InstallTemplatesResult> {
	const result: InstallTemplatesResult = {
		installed: [],
		skipped: [],
		failed: [],
	};

	// Ensure folder exists
	const normalized = normalizePath(basesFolder);
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (!existing) {
		await app.vault.createFolder(normalized);
	} else if (!(existing instanceof TFolder)) {
		return {
			installed: [],
			skipped: [],
			failed: [{ name: basesFolder, error: 'Path exists but is not a folder' }],
		};
	}

	// Install each template
	for (const template of BASES_TEMPLATES) {
		const filePath = normalizePath(`${basesFolder}/${template.fileName}`);

		try {
			const existingFile = app.vault.getAbstractFileByPath(filePath);

			if (existingFile && !force) {
				result.skipped.push(template.name);
				continue;
			}

			if (existingFile) {
				await app.vault.adapter.write(filePath, template.content);
			} else {
				await app.vault.create(filePath, template.content);
			}

			result.installed.push(template.name);
		} catch (err) {
			result.failed.push({
				name: template.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}
