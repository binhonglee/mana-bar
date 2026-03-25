import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigManager } from '../../src/managers/config-manager';
import { UsageManager } from '../../src/managers/usage-manager';
import { registerUsageProviders } from '../../src/provider-registration';

describe('Copilot provider integration', () => {
	let usageManager: UsageManager | undefined;

	beforeEach(() => {
		(vscode as any).__testing.reset();
		vi.spyOn(console, 'log').mockImplementation(() => { });
		vi.spyOn(console, 'error').mockImplementation(() => { });
		(vscode as any).__testing.setConfiguration('manaBar', 'services', {
			claudeCode: { enabled: false },
			codex: { enabled: false },
			vscodeCopilot: { enabled: true },
			copilotCli: { enabled: false },
			antigravity: { enabled: false },
			gemini: { enabled: false },
		});
	});

	afterEach(() => {
		usageManager?.dispose();
		usageManager = undefined;
		vi.restoreAllMocks();
	});

	it('registers VSCode Copilot and surfaces usage when the service is enabled', async () => {
		(vscode as any).__testing.registerExtension({
			id: 'GitHub.copilot-chat',
			packageJSON: { version: '0.36.2-test' },
			exports: {
				userInfo: {
					raw: {
						quota_snapshots: {
							premium_interactions: {
								entitlement: 100,
								percent_remaining: 80,
								overage_permitted: false,
								overage_count: 0,
							},
						},
						quota_reset_date: '2026-03-10T18:00:00.000Z',
					},
				},
			},
		});

		usageManager = new UsageManager(new ConfigManager());
		await registerUsageProviders(usageManager, {
			extensionUri: vscode.Uri.file('/extension-root'),
			subscriptions: [],
			globalState: {
				get: () => undefined,
				update: async () => undefined,
			},
		} as unknown as vscode.ExtensionContext);

		await usageManager.refreshAll();

		expect(usageManager.getRegisteredServiceNames()).toContain('VSCode Copilot');
		expect(usageManager.getUsageData('VSCode Copilot')).toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 20,
			totalLimit: 100,
		});
	});

	it('surfaces usage through the auth entitlement path when a GitHub session exists', async () => {
		(vscode as any).__testing.registerExtension({
			id: 'GitHub.copilot-chat',
			packageJSON: { version: '0.36.2-test' },
			exports: {},
		});
		(vscode as any).__testing.registerAuthenticationSession({
			providerId: 'github',
			session: {
				id: 'github-session',
				accessToken: 'github-token',
				account: {
					id: 'github-account',
					label: 'GitHub User',
				},
				scopes: ['read:user', 'user:email', 'repo', 'workflow'],
			},
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
			copilot_plan: 'individual',
			quota_snapshots: {
				premium_interactions: {
					entitlement: 100,
					percent_remaining: 60,
					overage_permitted: false,
					overage_count: 0,
				},
			},
			quota_reset_date: '2026-03-10T18:00:00.000Z',
		}))) as unknown as typeof fetch;

		try {
			usageManager = new UsageManager(new ConfigManager());
			await registerUsageProviders(usageManager, {
				extensionUri: vscode.Uri.file('/extension-root'),
				subscriptions: [],
				globalState: {
					get: () => undefined,
					update: async () => undefined,
				},
			} as unknown as vscode.ExtensionContext);

			await usageManager.refreshAll();

			expect(usageManager.getRegisteredServiceNames()).toContain('VSCode Copilot');
			expect(usageManager.getUsageData('VSCode Copilot')).toMatchObject({
				serviceName: 'VSCode Copilot',
				totalUsed: 40,
				totalLimit: 100,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
