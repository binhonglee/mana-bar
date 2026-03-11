import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerUsageProviders } from '../../src/provider-registration';
import { UsageProvider } from '../../src/providers/base';

class StaticProvider extends UsageProvider {
	constructor(private readonly serviceName: string) {
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

describe('registerUsageProviders', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		(vscode as any).__testing.reset();
	});

	it('uses the injected test harness in test mode', async () => {
		const registered: string[] = [];
		const testHarness = {
			registerProviders: vi.fn(async (usageManager: { registerProvider: (provider: UsageProvider) => void }) => {
				usageManager.registerProvider(new StaticProvider('Test Provider'));
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
		} as any, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			factories: {
				createClaudeCodeProvider: () => new StaticProvider('Claude Code'),
				createCodexProvider: () => new StaticProvider('Codex'),
				createCopilotProvider: () => new StaticProvider('VSCode Copilot'),
				createAntigravityProvider: () => ({
					...new StaticProvider('Antigravity'),
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('Antigravity Gemini Flash'));
					},
				}) as any,
				createGeminiProvider: () => ({
					...new StaticProvider('Gemini CLI'),
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('Gemini CLI 2.5 Pro'));
					},
				}) as any,
			},
		});

		expect(registered).toEqual([
			'Claude Code',
			'Codex',
			'VSCode Copilot',
			'Antigravity Gemini Flash',
			'Gemini CLI 2.5 Pro',
		]);
	});

	it('logs discovery failures and continues registering remaining providers', async () => {
		const registered: string[] = [];
		await registerUsageProviders({
			registerProvider: (provider: UsageProvider) => {
				registered.push(provider.getServiceName());
			},
		} as any, {
			extensionUri: vscode.Uri.file('/extension-root'),
		} as any, {
			factories: {
				createClaudeCodeProvider: () => new StaticProvider('Claude Code'),
				createCodexProvider: () => new StaticProvider('Codex'),
				createCopilotProvider: () => new StaticProvider('VSCode Copilot'),
				createAntigravityProvider: () => ({
					...new StaticProvider('Antigravity'),
					discoverQuotaGroups: async () => {
						throw new Error('antigravity failed');
					},
				}) as any,
				createGeminiProvider: () => ({
					...new StaticProvider('Gemini CLI'),
					discoverQuotaGroups: async (callback: (provider: UsageProvider) => void) => {
						callback(new StaticProvider('Gemini CLI 2.5 Pro'));
					},
				}) as any,
			},
		});

		expect(console.error).toHaveBeenCalledWith('[Antigravity] Discovery failed:', expect.any(Error));
		expect(registered).toEqual([
			'Claude Code',
			'Codex',
			'VSCode Copilot',
			'Gemini CLI 2.5 Pro',
		]);
	});
});
