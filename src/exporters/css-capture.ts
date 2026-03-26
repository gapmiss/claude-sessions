/**
 * CSS capture utilities for HTML export.
 * Extracts theme variables and relevant Obsidian styles at export time.
 */

/** Selectors whose rules we need from app.css for markdown rendering + syntax highlighting. */
const NEEDED_SELECTORS = [
	'markdown-rendered',
	'token',          // PrismJS syntax highlighting
	'copy-code-button',
	'svg-icon',
	'language-',      // code[class*="language-"]
];

/** Scrape all CSS custom properties from the document, resolved to computed values. */
export function captureThemeVariables(): string {
	const rootStyle = getComputedStyle(document.documentElement);
	const bodyStyle = getComputedStyle(document.body);

	// Collect all custom property names from all stylesheets
	const varNames = new Set<string>();
	const sheets = Array.from(document.styleSheets);
	for (const sheet of sheets) {
		try {
			const rules = Array.from(sheet.cssRules);
			for (const rule of rules) {
				if (rule instanceof CSSStyleRule && rule.style) {
					for (let i = 0; i < rule.style.length; i++) {
						const prop = rule.style[i];
						if (prop.startsWith('--')) varNames.add(prop);
					}
				}
			}
		} catch {
			// Cross-origin stylesheet, skip
		}
	}

	// Resolve to computed values
	const declarations: string[] = [];
	for (const name of varNames) {
		const val = rootStyle.getPropertyValue(name).trim() || bodyStyle.getPropertyValue(name).trim();
		if (val) {
			declarations.push(`  ${name}: ${val};`);
		}
	}

	return `:root {\n${declarations.join('\n')}\n}`;
}

/** Extract rules from app.css that are relevant to our rendered DOM. */
export function captureMarkdownStyles(): string {
	const result: string[] = [];

	const sheets = Array.from(document.styleSheets);
	for (const sheet of sheets) {
		// Only process app.css (linked stylesheet from obsidian.md)
		if (!(sheet.ownerNode instanceof HTMLLinkElement)) continue;
		if (!sheet.href?.includes('app.css')) continue;

		try {
			const rules = Array.from(sheet.cssRules);
			for (const rule of rules) {
				const text = rule.cssText;
				if (NEEDED_SELECTORS.some(s => text.includes(s))) {
					result.push(text);
				}
			}
		} catch {
			// Cross-origin, skip
		}
	}

	return result.join('\n\n');
}

/** Capture the plugin's own stylesheet (sheet containing claude-sessions rules). */
export function capturePluginStyles(): string {
	const result: string[] = [];

	const sheets = Array.from(document.styleSheets);
	for (const sheet of sheets) {
		try {
			const rules = Array.from(sheet.cssRules);
			if (rules[0]?.cssText.includes('claude-sessions')) {
				for (const rule of rules) {
					result.push(rule.cssText);
				}
				break;
			}
		} catch {
			// Cross-origin, skip
		}
	}

	return result.join('\n\n');
}

/** Capture all CSS needed for standalone HTML export. */
export function captureAllCSS(): string {
	const sections = [
		'/* === Theme Variables === */',
		captureThemeVariables(),
		'',
		'/* === Obsidian Markdown Rendering === */',
		captureMarkdownStyles(),
		'',
		'/* === Plugin Styles === */',
		capturePluginStyles(),
	];

	return sections.join('\n');
}
