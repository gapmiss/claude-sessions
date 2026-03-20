import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: "./tsconfig.json",
				sourceType: "module",
			},
		},
		plugins: {
			obsidianmd: obsidianmd,
		},
		rules: obsidianmd.configs.recommended,
	},
	{
		ignores: ["node_modules/**", "main.js"],
	},
];
