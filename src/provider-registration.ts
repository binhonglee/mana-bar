import * as vscode from 'vscode';
import { UsageManager } from './managers/usage-manager';
import { ClaudeCodeProvider } from './providers/claude-code';
import { CodexProvider } from './providers/codex';
import { CopilotProvider } from './providers/copilot';
import { CopilotCliProvider } from './providers/copilot-cli';
import { AntigravityProvider } from './providers/antigravity';
import { GeminiProvider } from './providers/gemini';
import type { TestProviderHarness } from './testing/fake-providers';
import { UsageProvider } from './providers/base';
import { ServiceId } from './types';
import { getServiceDescriptor } from './services';

export interface ProviderRegistrationResult {
	testHarness?: TestProviderHarness;
}

interface DiscoverableProvider extends UsageProvider {
	discoverQuotaGroups(registerCallback: (provider: UsageProvider) => void): Promise<void>;
}

export interface ProviderRegistrationFactories {
	createClaudeCodeProvider?: () => UsageProvider;
	createCodexProvider?: (context: vscode.ExtensionContext) => UsageProvider;
	createCopilotProvider?: () => UsageProvider;
	createCopilotCliProvider?: () => UsageProvider;
	createAntigravityProvider?: (context: vscode.ExtensionContext) => DiscoverableProvider;
	createGeminiProvider?: () => DiscoverableProvider;
	createTestHarness?: () => TestProviderHarness;
}

interface StaticProviderRegistration {
	serviceId: ServiceId;
	mode: 'static';
	create: (context: vscode.ExtensionContext, factories?: ProviderRegistrationFactories) => UsageProvider;
}

interface DiscoverableProviderRegistration {
	serviceId: ServiceId;
	mode: 'discoverable';
	create: (context: vscode.ExtensionContext, factories?: ProviderRegistrationFactories) => DiscoverableProvider;
}

type ProviderRegistrationDescriptor = StaticProviderRegistration | DiscoverableProviderRegistration;

const PROVIDER_REGISTRATIONS: ProviderRegistrationDescriptor[] = [
	{
		serviceId: 'claudeCode',
		mode: 'static',
		create: (_context, factories) => factories?.createClaudeCodeProvider?.() ?? new ClaudeCodeProvider(),
	},
	{
		serviceId: 'codex',
		mode: 'static',
		create: (context, factories) => factories?.createCodexProvider?.(context) ?? new CodexProvider(context),
	},
	{
		serviceId: 'vscodeCopilot',
		mode: 'static',
		create: (_context, factories) => factories?.createCopilotProvider?.() ?? new CopilotProvider(),
	},
	{
		serviceId: 'copilotCli',
		mode: 'static',
		create: (context, factories) => factories?.createCopilotCliProvider?.() ?? new CopilotCliProvider(context),
	},
	{
		serviceId: 'antigravity',
		mode: 'discoverable',
		create: (context, factories) => factories?.createAntigravityProvider?.(context) ?? new AntigravityProvider(context),
	},
	{
		serviceId: 'gemini',
		mode: 'discoverable',
		create: (_context, factories) => factories?.createGeminiProvider?.() ?? new GeminiProvider(),
	},
];

export async function registerUsageProviders(
	usageManager: UsageManager,
	context: vscode.ExtensionContext,
	options?: {
		testMode?: boolean;
		factories?: ProviderRegistrationFactories;
	}
): Promise<ProviderRegistrationResult> {
	if (options?.testMode) {
		const { TestProviderHarness } = await import('./testing/fake-providers.js');
		const testHarness = options.factories?.createTestHarness?.() ?? new TestProviderHarness();
		await testHarness.registerProviders(usageManager);
		return { testHarness };
	}

	for (const registration of PROVIDER_REGISTRATIONS) {
		if (registration.mode === 'static') {
			usageManager.registerProvider(registration.create(context, options?.factories));
			continue;
		}

		const discoverableProvider = registration.create(context, options?.factories);
		try {
			await discoverableProvider.discoverQuotaGroups((provider) => {
				usageManager.registerProvider(provider);
			});
		} catch (error) {
			console.error(`[${getServiceDescriptor(registration.serviceId).name}] Discovery failed:`, error);
		}
	}

	return {};
}
