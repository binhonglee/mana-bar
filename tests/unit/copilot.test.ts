import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CopilotProvider } from '../../src/providers/copilot';

const RESET_TIME = '2026-03-10T18:00:00.000Z';
const PREMIUM_HEADER = `ent=100&rem=60&rst=${encodeURIComponent(RESET_TIME)}&ov=0&ovPerm=false`;

class FakeHttpsRequest extends EventEmitter {
	emitResponse(headers: Record<string, string>): void {
		this.emit('response', { headers });
	}
}

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

describe('CopilotProvider', () => {
	let provider: CopilotProvider | undefined;

	beforeEach(() => {
		(vscode as any).__testing.reset();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		provider?.dispose();
		provider = undefined;
		vi.restoreAllMocks();
	});

	it('waits for a numeric quota signal when Copilot is installed but no quota is exposed yet', async () => {
		registerCopilotExtension('GitHub.copilot', { session: { status: 'ready' } });
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await expect(provider.isAvailable()).resolves.toBe(true);
		await expect(provider.getUsage()).resolves.toBeNull();
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[Copilot] Waiting for first numeric quota signal'));
	});

	it('normalizes quotaInfo discovered from extension exports', async () => {
		registerCopilotExtension('GitHub.copilot', {
			auth: {
				quotaInfo: {
					quota: 120,
					used: 35,
					resetDate: RESET_TIME,
					overageEnabled: false,
					overageUsed: 0,
				},
			},
		});
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 35,
			totalLimit: 120,
		});
	});

	it('fetches Copilot entitlement data via a GitHub auth session', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {});
		registerAuthSession('github');
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe('https://api.github.com/copilot_internal/user');
			return new Response(JSON.stringify({
				copilot_plan: 'individual',
				quota_snapshots: {
					premium_interactions: {
						entitlement: 100,
						percent_remaining: 75,
						overage_permitted: false,
						overage_count: 0,
					},
				},
				quota_reset_date: RESET_TIME,
			}));
		});
		const globalObject = {
			fetch: fetchImpl as unknown as typeof fetch,
		};
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			globalObject,
		});

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 25,
			totalLimit: 100,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.github.com/copilot_internal/user',
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({
					Authorization: 'Bearer github-token',
				}),
			})
		);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[Copilot Auth] Resolved entitlement'));
	});

	it('uses the enterprise Copilot entitlement URL when enterprise auth is configured', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {});
		registerAuthSession('github-enterprise');
		(vscode as any).__testing.setConfiguration('github.copilot', 'advanced', {
			authProvider: 'github-enterprise',
		});
		(vscode as any).__testing.setConfiguration('github-enterprise', 'uri', 'https://acme.ghe.com');
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe('https://api.acme.ghe.com/copilot_internal/user');
			return new Response(JSON.stringify({
				access_type_sku: 'free_limited_copilot',
				monthly_quotas: {
					chat: 100,
					completions: 1000,
				},
				limited_user_quotas: {
					chat: 70,
					completions: 950,
				},
				limited_user_reset_date: RESET_TIME,
			}));
		});
		const globalObject = {
			fetch: fetchImpl as unknown as typeof fetch,
		};
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			globalObject,
		});

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 30,
			totalLimit: 100,
			quotaWindows: [
				{
					label: 'Chat messages',
					used: 30,
					limit: 100,
				},
				{
					label: 'Inline suggestions',
					used: 50,
					limit: 1000,
				},
			],
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.acme.ghe.com/copilot_internal/user',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer github-enterprise-token',
				}),
			})
		);
	});

	it('falls back to any accessible GitHub session when Copilot scope presets do not match exactly', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {});
		registerAuthSession('github', {
			scopes: ['gist'],
		});
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe('https://api.github.com/copilot_internal/user');
			return new Response(JSON.stringify({
				copilot_plan: 'individual',
				quota_snapshots: {
					premium_interactions: {
						entitlement: 100,
						percent_remaining: 90,
						overage_permitted: false,
						overage_count: 0,
					},
				},
				quota_reset_date: RESET_TIME,
			}));
		});
		const globalObject = {
			fetch: fetchImpl as unknown as typeof fetch,
		};
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			globalObject,
		});

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 10,
			totalLimit: 100,
		});
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[Copilot Auth] Reusing github session with fallback scopes=gist'));
	});

	it('falls back to persisted GitHub sessions from VS Code secret storage', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {});
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(String(input)).toBe('https://api.github.com/copilot_internal/user');
			expect(init?.headers).toMatchObject({
				Authorization: 'Bearer persisted-token',
			});
			return new Response(JSON.stringify({
				copilot_plan: 'individual',
				quota_snapshots: {
					chat: {
						entitlement: 500,
						percent_remaining: 94,
						overage_permitted: false,
						overage_count: 0,
					},
					completions: {
						entitlement: 4000,
						percent_remaining: 95,
						overage_permitted: false,
						overage_count: 0,
					},
				},
				quota_reset_date: RESET_TIME,
			}));
		});
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			globalObject: {
				fetch: fetchImpl as unknown as typeof fetch,
			},
			readPersistedSecret: async (serviceId) => {
				expect(serviceId).toBe('github.auth');
				return JSON.stringify([
					{
						id: 'persisted-session',
						accessToken: 'persisted-token',
						account: {
							id: 'persisted-account',
							label: 'persisted user',
						},
						scopes: ['read:user', 'user:email'],
					},
				]);
			},
		});

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 30,
			totalLimit: 500,
			quotaWindows: [
				{
					label: 'Chat messages',
					used: 30,
					limit: 500,
				},
				{
					label: 'Inline suggestions',
					used: 200,
					limit: 4000,
				},
			],
		});
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[Copilot Auth] Reusing persisted github session'));
	});

	it('is available when Copilot is not installed but a persisted GitHub session exists', async () => {
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			readPersistedSecret: async () => JSON.stringify([
				{
					id: 'persisted-session',
					accessToken: 'persisted-token',
					account: {
						id: 'persisted-account',
						label: 'persisted user',
					},
					scopes: ['read:user'],
				},
			]),
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
	});

	it('normalizes raw quota_snapshots discovered from extension exports', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {
			userInfo: {
				raw: {
					quota_snapshots: {
						premium_interactions: {
							entitlement: 100,
							percent_remaining: 75,
							overage_permitted: false,
							overage_count: 0,
						},
					},
					quota_reset_date: RESET_TIME,
				},
			},
		});
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 25,
			totalLimit: 100,
		});
	});

	it('normalizes quotaInfo returned from the chat extension getAPI(1) export', async () => {
		const getAPI = vi.fn(() => ({
			auth: {
				quotaInfo: {
					quota: 80,
					used: 12,
					resetDate: RESET_TIME,
					overageEnabled: false,
					overageUsed: 0,
				},
			},
		}));
		registerCopilotExtension('GitHub.copilot-chat', { getAPI });
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 12,
			totalLimit: 80,
		});
		expect(getAPI).toHaveBeenCalledWith(1);
	});

	it('normalizes quotaInfo exposed through a prototype getter', async () => {
		class CopilotTokenWrapper {
			get quotaInfo() {
				return {
					quota: 90,
					used: 18,
					resetDate: RESET_TIME,
					overageEnabled: false,
					overageUsed: 0,
				};
			}
		}

		registerCopilotExtension('GitHub.copilot', {
			auth: new CopilotTokenWrapper(),
		});
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await expect(provider.getUsage()).resolves.toMatchObject({
			serviceName: 'VSCode Copilot',
			totalUsed: 18,
			totalLimit: 90,
		});
	});

	it('parses quota headers from intercepted fetch responses', async () => {
		registerCopilotExtension('GitHub.copilot', {});
		const fetchImpl = vi.fn(async () => new Response('', {
			headers: {
				'x-quota-snapshot-premium_models': PREMIUM_HEADER,
			},
		}));
		const globalObject = {
			fetch: fetchImpl as typeof fetch,
		};
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			globalObject,
		});

		await provider.isAvailable();
		await globalObject.fetch('https://copilot.test/completions');

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await expect(provider.getUsage()).resolves.toMatchObject({
			totalUsed: 40,
			totalLimit: 100,
		});
	});

	it('parses quota headers from intercepted https responses and restores patched functions on dispose', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {});
		const requests: FakeHttpsRequest[] = [];
		const requestImpl = vi.fn(() => {
			const request = new FakeHttpsRequest();
			requests.push(request);
			return request as any;
		});
		const getImpl = vi.fn(() => {
			const request = new FakeHttpsRequest();
			requests.push(request);
			return request as any;
		});
		const httpsModule = {
			request: requestImpl as any,
			get: getImpl as any,
		} as any;
		const fetchImpl = vi.fn(async () => new Response(''));
		const globalObject = {
			fetch: fetchImpl as typeof fetch,
		};
		provider = new CopilotProvider({
			vscodeApi: vscode as any,
			httpsModule,
			globalObject,
		});

		await provider.isAvailable();
		expect(httpsModule.request).not.toBe(requestImpl);

		(httpsModule.request as typeof requestImpl)('https://copilot.test/chat');
		requests[0]?.emitResponse({
			'x-quota-snapshot-premium_interactions': PREMIUM_HEADER,
		});

		await expect(provider.getUsage()).resolves.toMatchObject({
			totalUsed: 40,
			totalLimit: 100,
		});

		provider.dispose();
		expect(httpsModule.request).toBe(requestImpl);
		expect(httpsModule.get).toBe(getImpl);
		provider = undefined;
	});

	it('records chat and completions quotaExceeded context keys without fabricating numeric usage', async () => {
		registerCopilotExtension('GitHub.copilot-chat', {});
		const originalExecuteCommand = vscode.commands.executeCommand;
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await provider.isAvailable();
		await vscode.commands.executeCommand('setContext', 'github.copilot.chat.quotaExceeded', true);
		await vscode.commands.executeCommand('setContext', 'github.copilot.completions.quotaExceeded', false);

		await expect(provider.getUsage()).resolves.toBeNull();
		expect(console.log).toHaveBeenCalledWith('[Copilot Context] github.copilot.chat.quotaExceeded=true');
		expect(console.log).toHaveBeenCalledWith('[Copilot Context] github.copilot.completions.quotaExceeded=false');

		provider.dispose();
		expect(vscode.commands.executeCommand).toBe(originalExecuteCommand);
		provider = undefined;
	});

	it('hides unlimited quota snapshots from the UI', async () => {
		registerCopilotExtension('GitHub.copilot', {
			auth: {
				quotaInfo: {
					quota: -1,
					used: 0,
					unlimited: true,
					resetDate: RESET_TIME,
				},
			},
		});
		provider = new CopilotProvider({ vscodeApi: vscode as any });

		await expect(provider.getUsage()).resolves.toBeNull();
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('hiding VSCode Copilot because the quota is unbounded'));
	});
});
