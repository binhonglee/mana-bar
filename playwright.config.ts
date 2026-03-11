import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/browser',
	testMatch: ['**/*.spec.ts'],
	reporter: 'list',
	use: {
		headless: true,
		viewport: { width: 1400, height: 1000 },
	},
});
