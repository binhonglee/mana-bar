import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
	const extensionDevelopmentPath = path.resolve(__dirname, '../..');
	const extensionTestsPath = path.resolve(__dirname, './src/index.js');
	const workspacePath = path.resolve(__dirname, '../../tests/e2e/fixture-workspace');

	await runTests({
		extensionDevelopmentPath,
		extensionTestsPath,
		launchArgs: [workspacePath, '--disable-extensions'],
		extensionTestsEnv: {
			LLM_USAGE_TRACKER_TEST_MODE: '1',
		},
	});
}

main().catch((error) => {
	console.error('Failed to run extension tests');
	console.error(error);
	process.exit(1);
});
