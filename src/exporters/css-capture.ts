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
function captureThemeVariables(): string {
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
function captureMarkdownStyles(): string {
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
function capturePluginStyles(): string {
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

/** Capture @font-face rules with embedded (data:) sources so bundled fonts survive export. */
function captureFontFaces(): string {
	const result: string[] = [];

	const sheets = Array.from(document.styleSheets);
	for (const sheet of sheets) {
		try {
			const rules = Array.from(sheet.cssRules);
			for (const rule of rules) {
				if (rule instanceof CSSFontFaceRule) {
					const src = rule.style.getPropertyValue('src');
					if (src.includes('data:')) {
						result.push(rule.cssText);
					}
				}
			}
		} catch {
			// Cross-origin stylesheet, skip
		}
	}

	return result.join('\n\n');
}

/**
 * Capture resolved --cs-* theme variables from the live container element.
 * This picks up overrides from CSS snippets (e.g. custom themes) that
 * capturePluginStyles() misses since it only grabs the main plugin stylesheet.
 */
function capturePluginThemeOverrides(): string {
	const container = document.querySelector('.claude-sessions-timeline-container');
	if (!container) return '';

	const computed = getComputedStyle(container);

	// Collect all --cs-* variable names from all stylesheets
	const csVarNames = new Set<string>();
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			for (const rule of Array.from(sheet.cssRules)) {
				if (rule instanceof CSSStyleRule && rule.style) {
					for (let i = 0; i < rule.style.length; i++) {
						const prop = rule.style[i];
						if (prop.startsWith('--cs-')) csVarNames.add(prop);
					}
				}
			}
		} catch {
			// Cross-origin stylesheet, skip
		}
	}

	if (csVarNames.size === 0) return '';

	// Resolve to computed values from the actual container element
	const declarations: string[] = [];
	for (const name of csVarNames) {
		const val = computed.getPropertyValue(name).trim();
		if (val) {
			declarations.push(`  ${name}: ${val};`);
		}
	}

	return `.claude-sessions-timeline-container {\n${declarations.join('\n')}\n}`;
}

/** Capture all CSS needed for standalone HTML export. */
export function captureAllCSS(): string {
	const sections = [
		'/* === Embedded Fonts === */',
		captureFontFaces(),
		'',
		'/* === Theme Variables === */',
		captureThemeVariables(),
		'',
		'/* === Obsidian Markdown Rendering === */',
		captureMarkdownStyles(),
		'',
		'/* === Plugin Styles === */',
		capturePluginStyles(),
		'',
		'/* === Plugin Theme Overrides (resolved from live container) === */',
		capturePluginThemeOverrides(),
	];

	return sections.join('\n');
}
