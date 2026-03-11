import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, 'tests/support/vscode.ts'),
		},
	},
	test: {
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			reporter: ['text', 'lcov'],
			reportsDirectory: 'coverage/unit',
		},
	},
});
