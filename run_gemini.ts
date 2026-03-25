import { GeminiProvider } from './src/providers/gemini';

async function run() {
	console.log('Initializing GeminiProvider...');
	const provider = new GeminiProvider();

	if (!(await provider.isAvailable())) {
		console.log('GeminiProvider is not available. Please check authentication and CLI.');
		return;
	}

	const usageProviders: any[] = [];
	await provider.discoverQuotaGroups((p) => usageProviders.push(p));

	console.log(`Discovered ${usageProviders.length} sub-providers for Gemini CLI models.`);

	for (const p of usageProviders) {
		console.log(`\nFetching usage for: ${p.getServiceName()}...`);
		try {
			const usage = await p.getUsage();
			console.log(JSON.stringify(usage, null, 2));
		} catch (e) {
			console.error(`Error fetching usage for ${p.getServiceName()}:`, e);
		}
	}
}

run().catch(console.error);
