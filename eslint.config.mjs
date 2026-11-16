import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// Build output, Node build scripts, and tests (not in tsconfig) are not plugin code.
	globalIgnores(["node_modules", "main.js", "examples", "tests", "esbuild.config.mjs", "version-bump.mjs", "release.mjs", "vitest.config.mts"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
			},
		},
	},
	{
		files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", {
				enforceCamelCaseLower: true,
				// "Claude Code" is a product name; "Agent" is a tool name.
				ignoreWords: ["Code", "Agent"],
				// Quoted command names keep their own casing.
				ignoreRegex: ['"[^"]+"'],
			}],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
]);
