import { CursorProvider } from './src/providers/cursor';

async function run() {
	console.log('Initializing CursorProvider...');
	const provider = new CursorProvider();

	if (!(await provider.isAvailable())) {
		console.log('CursorProvider is not available. No editor DB, CLI keychain token, or env token found.');
		return;
	}

	console.log('Available. Fetching usage...');
	const usage = await provider.getUsage();
	console.log(JSON.stringify(usage, null, 2));
}

run().catch(console.error);
