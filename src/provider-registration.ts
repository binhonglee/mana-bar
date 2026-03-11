import * as vscode from 'vscode';
import { UsageManager } from './managers/usage-manager';
import { ClaudeCodeProvider } from './providers/claude-code';
import { CodexProvider } from './providers/codex';
import { AntigravityProvider } from './providers/antigravity';
import { GeminiProvider } from './providers/gemini';
import { TestProviderHarness } from './testing/fake-providers';

export interface ProviderRegistrationResult {
	testHarness?: TestProviderHarness;
}

export async function registerUsageProviders(
	usageManager: UsageManager,
	context: vscode.ExtensionContext,
	options?: {
		testMode?: boolean;
	}
): Promise<ProviderRegistrationResult> {
	if (options?.testMode) {
		const testHarness = new TestProviderHarness();
		await testHarness.registerProviders(usageManager);
		return { testHarness };
	}

	const claudeCodeProvider = new ClaudeCodeProvider();
	usageManager.registerProvider(claudeCodeProvider);

	const codexProvider = new CodexProvider(context);
	usageManager.registerProvider(codexProvider);

	const antigravityProvider = new AntigravityProvider(context);
	try {
		await antigravityProvider.discoverQuotaGroups((provider) => {
			usageManager.registerProvider(provider);
		});
	} catch (error) {
		console.error('[Antigravity] Discovery failed:', error);
	}

	const geminiProvider = new GeminiProvider();
	try {
		await geminiProvider.discoverQuotaGroups((provider) => {
			usageManager.registerProvider(provider);
		});
	} catch (error) {
		console.error('[Gemini] Discovery failed:', error);
	}

	return {};
}
