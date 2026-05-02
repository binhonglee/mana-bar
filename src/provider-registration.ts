import * as vscode from 'vscode';
import { UsageManager } from './managers/usage-manager';
import { ClaudeCodeProvider } from './providers/claude-code';
import { CodexProvider } from './providers/codex';
import { CopilotProvider } from './providers/copilot';
import { CopilotCliProvider } from './providers/copilot-cli';
import { CursorProvider } from './providers/cursor';
import { AntigravityProvider } from './providers/antigravity';
import { GeminiProvider } from './providers/gemini';
import { KiroDiscoverable } from './providers/kiro';
import type { TestProviderHarness } from './testing/fake-providers';
import { UsageProvider } from './providers/base';
import { ServiceId } from './types';
import { getServiceDescriptor } from './services';

export interface ProviderRegistrationResult {
	testHarness?: TestProviderHarness;
}

export interface DiscoverableProvider extends UsageProvider {
	discoverQuotaGroups(registerCallback: (provider: UsageProvider) => void): Promise<void>;
	resetDiscovery(): void;
}

export interface ProviderRegistrationFactories {
	createClaudeCodeProvider?: () => UsageProvider;
	createCodexProvider?: (context: vscode.ExtensionContext) => UsageProvider;
	createCopilotProvider?: () => UsageProvider;
	createCopilotCliProvider?: () => UsageProvider;
	createCursorProvider?: () => UsageProvider;
	createAntigravityProvider?: (context: vscode.ExtensionContext) => DiscoverableProvider;
	createGeminiProvider?: () => DiscoverableProvider;
	createKiroProvider?: () => DiscoverableProvider;
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
		serviceId: 'cursor',
		mode: 'static',
		create: (_context, factories) => factories?.createCursorProvider?.() ?? new CursorProvider(),
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
	{
		serviceId: 'kiro',
		mode: 'discoverable',
		create: (_context, factories) => factories?.createKiroProvider?.() ?? new KiroDiscoverable(),
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

		const serviceId = registration.serviceId;
		usageManager.registerRediscovery(serviceId, async () => {
			discoverableProvider.resetDiscovery();
			usageManager.removeProvidersByServiceId(serviceId);
			await discoverableProvider.discoverQuotaGroups((sub) => {
				usageManager.registerProvider(sub);
			});
		});
	}

	return {};
}
