import * as vscode from 'vscode';
import { UsageManager } from './managers/usage-manager';
import { ClaudeCodeProvider } from './providers/claude-code';
import { CodexProvider } from './providers/codex';
import { AntigravityProvider } from './providers/antigravity';
import { GeminiProvider } from './providers/gemini';
import { TestProviderHarness } from './testing/fake-providers';
import { UsageProvider } from './providers/base';

export interface ProviderRegistrationResult {
	testHarness?: TestProviderHarness;
}

interface DiscoverableProvider extends UsageProvider {
	discoverQuotaGroups(registerCallback: (provider: UsageProvider) => void): Promise<void>;
}

export interface ProviderRegistrationFactories {
	createClaudeCodeProvider?: () => UsageProvider;
	createCodexProvider?: (context: vscode.ExtensionContext) => UsageProvider;
	createAntigravityProvider?: (context: vscode.ExtensionContext) => DiscoverableProvider;
	createGeminiProvider?: () => DiscoverableProvider;
	createTestHarness?: () => TestProviderHarness;
}

export async function registerUsageProviders(
	usageManager: UsageManager,
	context: vscode.ExtensionContext,
	options?: {
		testMode?: boolean;
		factories?: ProviderRegistrationFactories;
	}
): Promise<ProviderRegistrationResult> {
	if (options?.testMode) {
		const testHarness = options.factories?.createTestHarness?.() ?? new TestProviderHarness();
		await testHarness.registerProviders(usageManager);
		return { testHarness };
	}

	const claudeCodeProvider = options?.factories?.createClaudeCodeProvider?.() ?? new ClaudeCodeProvider();
	usageManager.registerProvider(claudeCodeProvider);

	const codexProvider = options?.factories?.createCodexProvider?.(context) ?? new CodexProvider(context);
	usageManager.registerProvider(codexProvider);

	const antigravityProvider = options?.factories?.createAntigravityProvider?.(context) ?? new AntigravityProvider(context);
	try {
		await antigravityProvider.discoverQuotaGroups((provider) => {
			usageManager.registerProvider(provider);
		});
	} catch (error) {
		console.error('[Antigravity] Discovery failed:', error);
	}

	const geminiProvider = options?.factories?.createGeminiProvider?.() ?? new GeminiProvider();
	try {
		await geminiProvider.discoverQuotaGroups((provider) => {
			usageManager.registerProvider(provider);
		});
	} catch (error) {
		console.error('[Gemini] Discovery failed:', error);
	}

	return {};
}
