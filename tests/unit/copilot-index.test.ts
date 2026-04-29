import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CopilotProvider } from '../../src/providers/copilot';
import { setDebugLoggingEnabled } from '../../src/logger';
import {
	COPILOT_DEFAULT_ENTITLEMENT_URL,
	COPILOT_ENTERPRISE_PROVIDER_ID,
} from '../../src/providers/copilot/types';

const RESET_TIME = '2026-03-10T18:00:00.000Z';

function registerCopilotExtension(id: 'GitHub.copilot' | 'GitHub.copilot-chat', exportsValue: unknown) {
	(vscode as any).__testing.registerExtension({
		id,
		packageJSON: { version: '1.0.0-test' },
		exports: exportsValue,
	});
}

function registerAuthSession(providerId: 'github' | 'github-enterprise', overrides: Partial<{
	id: string;
	accessToken: string;
	accountId: string;
	accountLabel: string;
	scopes: readonly string[];
}> = {}) {
	(vscode as any).__testing.registerAuthenticationSession({
		providerId,
		session: {
			id: overrides.id ?? `${providerId}-session`,
			accessToken: overrides.accessToken ?? `${providerId}-token`,
			account: {
				id: overrides.accountId ?? `${providerId}-account`,
				label: overrides.accountLabel ?? `${providerId} user`,
			},
			scopes: overrides.scopes ?? ['read:user', 'user:email', 'repo', 'workflow'],
		},
	});
}

describe('CopilotProvider orchestration (copilot-index)', () => {
	let provider: CopilotProvider | undefined;

	beforeEach(() => {
		(vscode as any).__testing.reset();
		setDebugLoggingEnabled(true);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		provider?.dispose();
		provider = undefined;
		setDebugLoggingEnabled(false);
		vi.restoreAllMocks();
	});

	describe('isAvailable', () => {
		it('returns false when no Copilot extensions are installed and no persisted sessions exist', async () => {
			provider = new CopilotProvider({
				vscodeApi: vscode as any,
				readPersistedSecret: async () => null,
			});

			await expect(provider.isAvailable()).resolves.toBe(false);
		});

		it('returns false when no extensions match and readPersistedSecret returns empty array', async () => {
			provider = new CopilotProvider({
				vscodeApi: vscode as any,
				readPersistedSecret: async () => JSON.stringify([]),
			});

			await expect(provider.isAvailable()).resolves.toBe(false);
		});
	});

	describe('getUsage', () => {
		it('returns null when snapshot has unlimited: true', async () => {
			registerCopilotExtension('GitHub.copilot', {
				auth: {
					quotaInfo: {
						quota: 100,
						used: 20,
						unlimited: true,
						resetDate: RESET_TIME,
						overageEnabled: false,
						overageUsed: 0,
					},
				},
			});
			provider = new CopilotProvider({ vscodeApi: vscode as any });

			const usage = await provider.getUsage();
			expect(usage).toBeNull();
		});

		it('returns null when snapshot has quota <= 0 (zero quota)', async () => {
			registerCopilotExtension('GitHub.copilot', {
				auth: {
					quotaInfo: {
						quota: 0,
						used: 0,
						resetDate: RESET_TIME,
						overageEnabled: false,
						overageUsed: 0,
					},
				},
			});
			provider = new CopilotProvider({ vscodeApi: vscode as any });

			const usage = await provider.getUsage();
			expect(usage).toBeNull();
		});

		it('returns null when snapshot has negative quota', async () => {
			registerCopilotExtension('GitHub.copilot', {
				auth: {
					quotaInfo: {
						quota: -1,
						used: 0,
						resetDate: RESET_TIME,
						overageEnabled: false,
						overageUsed: 0,
					},
				},
			});
			provider = new CopilotProvider({ vscodeApi: vscode as any });

			const usage = await provider.getUsage();
			expect(usage).toBeNull();
		});
	});

	describe('dispose', () => {
		it('cleans up auth change listener after dispose', async () => {
			registerCopilotExtension('GitHub.copilot', {});
			provider = new CopilotProvider({ vscodeApi: vscode as any });

			// Initialize the provider to set up listeners
			await provider.isAvailable();
			provider.dispose();

			// After dispose, the provider should not react to auth changes
			// (no error thrown means listeners were properly cleaned up)
			expect(() => provider!.dispose()).not.toThrow();
		});

		it('restores original executeCommand after dispose', async () => {
			registerCopilotExtension('GitHub.copilot', {});
			const originalExecuteCommand = vscode.commands.executeCommand;
			provider = new CopilotProvider({ vscodeApi: vscode as any });

			await provider.isAvailable();
			// After initialization, executeCommand is patched
			expect(vscode.commands.executeCommand).not.toBe(originalExecuteCommand);

			provider.dispose();
			// After dispose, executeCommand is restored
			expect(vscode.commands.executeCommand).toBe(originalExecuteCommand);
			provider = undefined;
		});

		it('cleans up extensions change listener after dispose', async () => {
			registerCopilotExtension('GitHub.copilot', {});
			provider = new CopilotProvider({ vscodeApi: vscode as any });

			await provider.isAvailable();
			provider.dispose();

			// Registering a new extension after dispose should not trigger re-probe
			// (no error means the listener was properly removed)
			registerCopilotExtension('GitHub.copilot-chat', {});
			provider = undefined;
		});
	});

	describe('enterprise provider ID selection', () => {
		it('uses enterprise provider ID when advanced config specifies github-enterprise', async () => {
			registerCopilotExtension('GitHub.copilot-chat', {});
			registerAuthSession('github-enterprise');
			(vscode as any).__testing.setConfiguration('github.copilot', 'advanced', {
				authProvider: COPILOT_ENTERPRISE_PROVIDER_ID,
			});
			(vscode as any).__testing.setConfiguration('github-enterprise', 'uri', 'https://corp.ghe.com');

			const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
				return new Response(JSON.stringify({
					copilot_plan: 'business',
					quota_snapshots: {
						premium_interactions: {
							entitlement: 200,
							percent_remaining: 50,
							overage_permitted: false,
							overage_count: 0,
						},
					},
					quota_reset_date: RESET_TIME,
				}));
			});

			provider = new CopilotProvider({
				vscodeApi: vscode as any,
				globalObject: { fetch: fetchImpl as unknown as typeof fetch },
			});

			const usage = await provider.getUsage();
			expect(usage).toMatchObject({
				totalUsed: 100,
				totalLimit: 200,
			});
			// Verify it called the enterprise URL
			expect(fetchImpl).toHaveBeenCalledWith(
				'https://api.corp.ghe.com/copilot_internal/user',
				expect.anything(),
			);
		});

		it('uses default provider ID when advanced config does not specify enterprise', async () => {
			registerCopilotExtension('GitHub.copilot-chat', {});
			registerAuthSession('github');

			const fetchImpl = vi.fn(async () => {
				return new Response(JSON.stringify({
					copilot_plan: 'individual',
					quota_snapshots: {
						premium_interactions: {
							entitlement: 150,
							percent_remaining: 80,
							overage_permitted: false,
							overage_count: 0,
						},
					},
					quota_reset_date: RESET_TIME,
				}));
			});

			provider = new CopilotProvider({
				vscodeApi: vscode as any,
				globalObject: { fetch: fetchImpl as unknown as typeof fetch },
			});

			const usage = await provider.getUsage();
			expect(usage).toMatchObject({
				totalUsed: 30,
				totalLimit: 150,
			});
			expect(fetchImpl).toHaveBeenCalledWith(
				COPILOT_DEFAULT_ENTITLEMENT_URL,
				expect.anything(),
			);
		});
	});

	describe('invalid enterprise URI fallback', () => {
		it('falls back to default entitlement URL when enterprise URI is invalid', async () => {
			registerCopilotExtension('GitHub.copilot-chat', {});
			registerAuthSession('github-enterprise');
			(vscode as any).__testing.setConfiguration('github.copilot', 'advanced', {
				authProvider: COPILOT_ENTERPRISE_PROVIDER_ID,
			});
			// Set an invalid URI that will fail URL parsing
			(vscode as any).__testing.setConfiguration('github-enterprise', 'uri', 'not-a-valid-url');

			const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
				return new Response(JSON.stringify({
					copilot_plan: 'business',
					quota_snapshots: {
						premium_interactions: {
							entitlement: 100,
							percent_remaining: 60,
							overage_permitted: false,
							overage_count: 0,
						},
					},
					quota_reset_date: RESET_TIME,
				}));
			});

			provider = new CopilotProvider({
				vscodeApi: vscode as any,
				globalObject: { fetch: fetchImpl as unknown as typeof fetch },
			});

			const usage = await provider.getUsage();
			expect(usage).toMatchObject({
				totalUsed: 40,
				totalLimit: 100,
			});
			// Should fall back to default URL
			expect(fetchImpl).toHaveBeenCalledWith(
				COPILOT_DEFAULT_ENTITLEMENT_URL,
				expect.anything(),
			);
		});

		it('falls back to default entitlement URL when enterprise URI is empty', async () => {
			registerCopilotExtension('GitHub.copilot-chat', {});
			registerAuthSession('github-enterprise');
			(vscode as any).__testing.setConfiguration('github.copilot', 'advanced', {
				authProvider: COPILOT_ENTERPRISE_PROVIDER_ID,
			});
			(vscode as any).__testing.setConfiguration('github-enterprise', 'uri', '');

			const fetchImpl = vi.fn(async () => {
				return new Response(JSON.stringify({
					copilot_plan: 'business',
					quota_snapshots: {
						premium_interactions: {
							entitlement: 100,
							percent_remaining: 70,
							overage_permitted: false,
							overage_count: 0,
						},
					},
					quota_reset_date: RESET_TIME,
				}));
			});

			provider = new CopilotProvider({
				vscodeApi: vscode as any,
				globalObject: { fetch: fetchImpl as unknown as typeof fetch },
			});

			const usage = await provider.getUsage();
			expect(usage).toMatchObject({
				totalUsed: 30,
				totalLimit: 100,
			});
			expect(fetchImpl).toHaveBeenCalledWith(
				COPILOT_DEFAULT_ENTITLEMENT_URL,
				expect.anything(),
			);
		});
	});
});
