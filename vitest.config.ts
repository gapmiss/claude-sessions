import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
	},
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
		},
	},
});
