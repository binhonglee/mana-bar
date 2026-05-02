import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerUsageProviders } from '../../src/provider-registration';
import { UsageProvider } from '../../src/providers/base';
import { UsageManager } from '../../src/managers/usage-manager';
import { ConfigManager } from '../../src/managers/config-manager';
import { ServiceId, UsageData } from '../../src/types';

class StaticProvider extends UsageProvider {
	constructor(readonly serviceId: ServiceId, private readonly serviceName: string) {
		super();
	}

	getServiceName(): string {
		return this.serviceName;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<null> {
		return null;
	}

	async getModels(): Promise<string[]> {
		return [];
	}
}

class UsageProviderWithData extends UsageProvider {
	constructor(readonly serviceId: ServiceId, private readonly serviceName: string) {
		super();
	}

	getServiceName(): string {
		return this.serviceName;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<UsageData> {
		return {
			serviceName: this.serviceName,
			totalUsed: 50,
			resetDate: new Date(),
			models: [],
		};
	}

	async getModels(): Promise<string[]> {
		return [];
	}
}

describe('registerUsageProviders', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		(vscode as any).__testing.reset();
	});

	it('uses the injected test harness in test mode', async () => {
		const registered: string[] = [];
		const testHarness = {
			registerProviders: vi.fn(async (usageManager: { registerProvider: (provider: UsageProvider) => void }) => {
				usageManager.registerProvider(new StaticProvider('codex', 'Test Provider'));
			}),
			advanceScenario: vi.fn(),
			getScenarioIndex: vi.fn(() => 0),
		};
		const result = await registerUsageProviders({
			registerProvider: (provider: UsageProvider) => {
				registered.push(provider.getServiceName());
			},
		} as any, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			testMode: true,
			factories: {
				createTestHarness: () => testHarness as any,
			},
		});

		expect(testHarness.registerProviders).toHaveBeenCalledTimes(1);
		expect(registered).toEqual(['Test Provider']);
		expect(result.testHarness).toBe(testHarness);
	});

	it('registers concrete providers and discovered quota groups in normal mode', async () => {
		const registered: string[] = [];
		await registerUsageProviders({
			registerProvider: (provider: UsageProvider) => {
				registered.push(provider.getServiceName());
			},
			registerRediscovery: () => {},
		} as any, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			factories: {
				createClaudeCodeProvider: () => new StaticProvider('claudeCode', 'Claude Code'),
				createCodexProvider: () => new StaticProvider('codex', 'Codex'),
				createCopilotProvider: () => new StaticProvider('vscodeCopilot', 'VSCode Copilot'),
				createCopilotCliProvider: () => new StaticProvider('copilotCli', 'Copilot CLI'),
				createCursorProvider: () => new StaticProvider('cursor', 'Cursor'),
				createAntigravityProvider: () => ({
					serviceId: 'antigravity' as const,
					getServiceName: () => 'Antigravity',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: () => {},
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('antigravity', 'Antigravity Gemini Flash'));
					},
				}) as any,
				createGeminiProvider: () => ({
					serviceId: 'gemini' as const,
					getServiceName: () => 'Gemini CLI',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: () => {},
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('gemini', 'Gemini CLI 2.5 Pro'));
					},
				}) as any,
				createKiroProvider: () => ({
					serviceId: 'kiro' as const,
					getServiceName: () => 'Kiro',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: () => {},
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('kiro', 'Kiro'));
					},
				}) as any,
			},
		});

		expect(registered).toEqual([
			'Claude Code',
			'Codex',
			'VSCode Copilot',
			'Copilot CLI',
			'Cursor',
			'Antigravity Gemini Flash',
			'Gemini CLI 2.5 Pro',
			'Kiro',
		]);
	});

	it('logs discovery failures and continues registering remaining providers', async () => {
		const registered: string[] = [];
		await registerUsageProviders({
			registerProvider: (provider: UsageProvider) => {
				registered.push(provider.getServiceName());
			},
			registerRediscovery: () => {},
		} as any, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			factories: {
				createClaudeCodeProvider: () => new StaticProvider('claudeCode', 'Claude Code'),
				createCodexProvider: () => new StaticProvider('codex', 'Codex'),
				createCopilotProvider: () => new StaticProvider('vscodeCopilot', 'VSCode Copilot'),
				createCopilotCliProvider: () => new StaticProvider('copilotCli', 'Copilot CLI'),
				createCursorProvider: () => new StaticProvider('cursor', 'Cursor'),
				createAntigravityProvider: () => ({
					serviceId: 'antigravity' as const,
					getServiceName: () => 'Antigravity',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: () => {},
					discoverQuotaGroups: async () => {
						throw new Error('antigravity failed');
					},
				}) as any,
				createGeminiProvider: () => ({
					serviceId: 'gemini' as const,
					getServiceName: () => 'Gemini CLI',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: () => {},
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('gemini', 'Gemini CLI 2.5 Pro'));
					},
				}) as any,
				createKiroProvider: () => ({
					serviceId: 'kiro' as const,
					getServiceName: () => 'Kiro',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: () => {},
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('kiro', 'Kiro'));
					},
				}) as any,
			},
		});

		expect(console.error).toHaveBeenCalledWith('[Antigravity] Discovery failed:', expect.any(Error));
		expect(registered).toEqual([
			'Claude Code',
			'Codex',
			'VSCode Copilot',
			'Copilot CLI',
			'Cursor',
			'Gemini CLI 2.5 Pro',
			'Kiro',
		]);
	});

	it('refreshAll auto-discovers antigravity after initial discovery failure', async () => {
		let antigravityCallCount = 0;
		const configManager = new ConfigManager();
		const usageManager = new UsageManager(configManager);

		await registerUsageProviders(usageManager, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			factories: {
				createClaudeCodeProvider: () => new StaticProvider('claudeCode', 'Claude Code'),
				createCodexProvider: () => new StaticProvider('codex', 'Codex'),
				createCopilotProvider: () => new StaticProvider('vscodeCopilot', 'VSCode Copilot'),
				createCopilotCliProvider: () => new StaticProvider('copilotCli', 'Copilot CLI'),
				createCursorProvider: () => new StaticProvider('cursor', 'Cursor'),
				createAntigravityProvider: () => ({
					serviceId: 'antigravity' as const,
					getServiceName: () => 'Antigravity',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: vi.fn(),
					discoverQuotaGroups: vi.fn(async (callback: (p: UsageProvider) => void) => {
						antigravityCallCount++;
						if (antigravityCallCount >= 2) {
							callback(new UsageProviderWithData('antigravity', 'Antigravity Gemini Flash'));
						}
					}),
				}) as any,
				createGeminiProvider: () => ({
					serviceId: 'gemini' as const,
					getServiceName: () => 'Gemini CLI',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: vi.fn(),
					discoverQuotaGroups: async (callback: (p: UsageProvider) => void) => {
						callback(new UsageProviderWithData('gemini', 'Gemini CLI 2.5 Pro'));
					},
				}) as any,
				createKiroProvider: () => ({
					serviceId: 'kiro' as const,
					getServiceName: () => 'Kiro',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: vi.fn(),
					discoverQuotaGroups: async (callback: (p: UsageProvider) => void) => {
						callback(new UsageProviderWithData('kiro', 'Kiro'));
					},
				}) as any,
			},
		});

		expect(usageManager.getRegisteredServiceNames()).not.toContain('Antigravity Gemini Flash');

		// refreshAll escalates: no antigravity data → re-discovers → registers the sub-provider
		await usageManager.refreshAll();
		expect(usageManager.getRegisteredServiceNames()).toContain('Antigravity Gemini Flash');
	});

	it('refreshAll replaces stale sub-providers when data is missing', async () => {
		let discoveryRound = 0;
		const configManager = new ConfigManager();
		const usageManager = new UsageManager(configManager);

		await registerUsageProviders(usageManager, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			factories: {
				createClaudeCodeProvider: () => new StaticProvider('claudeCode', 'Claude Code'),
				createCodexProvider: () => new StaticProvider('codex', 'Codex'),
				createCopilotProvider: () => new StaticProvider('vscodeCopilot', 'VSCode Copilot'),
				createCopilotCliProvider: () => new StaticProvider('copilotCli', 'Copilot CLI'),
				createCursorProvider: () => new StaticProvider('cursor', 'Cursor'),
				createAntigravityProvider: () => ({
					serviceId: 'antigravity' as const,
					getServiceName: () => 'Antigravity',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: vi.fn(),
					discoverQuotaGroups: vi.fn(async (callback: (p: UsageProvider) => void) => {
						discoveryRound++;
						if (discoveryRound === 1) {
							callback(new StaticProvider('antigravity', 'Antigravity Old Group'));
						} else {
							callback(new UsageProviderWithData('antigravity', 'Antigravity New Group'));
						}
					}),
				}) as any,
				createGeminiProvider: () => ({
					serviceId: 'gemini' as const,
					getServiceName: () => 'Gemini CLI',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: vi.fn(),
					discoverQuotaGroups: async (callback: (p: UsageProvider) => void) => {
						callback(new UsageProviderWithData('gemini', 'Gemini CLI 2.5 Pro'));
					},
				}) as any,
				createKiroProvider: () => ({
					serviceId: 'kiro' as const,
					getServiceName: () => 'Kiro',
					isAvailable: async () => true,
					getUsage: async () => null,
					getModels: async () => [],
					resetDiscovery: vi.fn(),
					discoverQuotaGroups: async (callback: (p: UsageProvider) => void) => {
						callback(new UsageProviderWithData('kiro', 'Kiro'));
					},
				}) as any,
			},
		});

		expect(usageManager.getRegisteredServiceNames()).toContain('Antigravity Old Group');

		// refreshAll: Old Group returns null → no data → re-discovers → New Group appears
		await usageManager.refreshAll();
		expect(usageManager.getRegisteredServiceNames()).not.toContain('Antigravity Old Group');
		expect(usageManager.getRegisteredServiceNames()).toContain('Antigravity New Group');
	});
});
