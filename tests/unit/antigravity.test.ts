import { describe, expect, it, vi } from 'vitest';
import { AntigravityProvider } from '../../src/providers/antigravity';
import {
	createExtensionContext,
	createFsSnapshot,
	FixedClock,
	jsonResponse,
	textResponse,
} from '../support/provider-test-utils';

const HOME = '/Users/test';
const CACHE_FILE = `${HOME}/.antigravity_cockpit/cache/quota_api_v1_plugin/authorized`;
const CREDENTIALS_FILE = `${HOME}/.antigravity_cockpit/credentials.json`;

const AUTHORIZED_RESPONSE = {
	models: {
		'gemini-flash': {
			displayName: 'Gemini 2.5 Flash',
			model: 'gemini-2.5-flash',
			quotaInfo: {
				remainingFraction: 0.4,
				resetTime: '2026-03-10T18:00:00.000Z',
			},
		},
		'claude-sonnet': {
			displayName: 'Claude 3.7 Sonnet',
			model: 'claude-3-7-sonnet',
			quotaInfo: {
				remainingFraction: 0.7,
				resetTime: '2026-03-10T16:00:00.000Z',
			},
		},
	},
	agentModelSorts: [
		{
			groups: [
				{ modelIds: ['gemini-flash', 'claude-sonnet'] },
			],
		},
	],
};

describe('AntigravityProvider', () => {
	it('is available when cached quota files already exist', async () => {
		const snapshot = createFsSnapshot({
			files: {
				[CACHE_FILE]: JSON.stringify({ payload: AUTHORIZED_RESPONSE }),
			},
			directories: {
				[`${HOME}/.antigravity_cockpit/cache/quota_api_v1_plugin`]: ['authorized'],
			},
			mtimes: {
				[CACHE_FILE]: 10,
			},
		});
		const fetch = vi.fn();
		const provider = new AntigravityProvider(createExtensionContext(), {
			homeDir: HOME,
			fetch: fetch as any,
			...snapshot,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('refreshes expired credentials when no cache is available', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const snapshot = createFsSnapshot({
			files: {
				[CREDENTIALS_FILE]: JSON.stringify({
					accounts: [
						{
							email: 'person@example.com',
							accessToken: 'old-token',
							refreshToken: 'refresh-token',
							expiresAt: Math.floor((clock.now() - 120_000) / 1000),
							projectId: 'proj-123',
						},
					],
				}),
			},
		});
		const fetch = vi.fn(async (url: string) => {
			expect(url).toBe('https://oauth2.googleapis.com/token');
			return jsonResponse({
				access_token: 'new-token',
				expires_in: 3600,
			});
		});
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: HOME,
			fetch: fetch as any,
			...snapshot,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('returns unavailable when token refresh fails and no cache exists', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const snapshot = createFsSnapshot({
			files: {
				[CREDENTIALS_FILE]: JSON.stringify({
					accounts: [
						{
							email: 'person@example.com',
							accessToken: 'old-token',
							refreshToken: 'refresh-token',
							expiresAt: Math.floor((clock.now() - 120_000) / 1000),
							projectId: 'proj-123',
						},
					],
				}),
			},
		});
		const fetch = vi.fn(async () => textResponse('denied', 401));
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: HOME,
			fetch: fetch as any,
			...snapshot,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('falls back from the daily endpoint, registers quota groups once, and exposes grouped usage', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const snapshot = createFsSnapshot({
			files: {
				[CREDENTIALS_FILE]: JSON.stringify({
					accounts: [
						{
							email: 'person@example.com',
							accessToken: 'live-token',
							refreshToken: 'refresh-token',
							expiresAt: clock.now() + 3_600_000,
							projectId: 'proj-123',
						},
					],
				}),
			},
		});
		const fetch = vi.fn(async (url: string) => {
			if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
				return textResponse('try prod', 500);
			}
			return jsonResponse(AUTHORIZED_RESPONSE);
		});
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: HOME,
			fetch: fetch as any,
			...snapshot,
		});
		const registered: string[] = [];
		const providers: Array<{ serviceId: string; getServiceName(): string; getUsage(): Promise<unknown> }> = [];

		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider.getServiceName());
			providers.push(usageProvider as any);
		});
		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(`duplicate:${usageProvider.getServiceName()}`);
		});

		expect(registered).toEqual([
			'Antigravity Gemini Flash',
			'Antigravity Claude',
		]);
		expect(providers.map(item => item.serviceId)).toEqual(['antigravity', 'antigravity']);
		expect(fetch).toHaveBeenCalledTimes(2);

		const flashProvider = providers.find(item => item.getServiceName() === 'Antigravity Gemini Flash');
		await expect(flashProvider?.getUsage()).resolves.toMatchObject({
			serviceName: 'Antigravity Gemini Flash',
			totalUsed: 60,
			progressSegments: 5,
		});
	});

	it('serves sub-provider usage from the shared cached quota response', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const snapshot = createFsSnapshot({
			files: {
				[CREDENTIALS_FILE]: JSON.stringify({
					accounts: [
						{
							email: 'person@example.com',
							accessToken: 'live-token',
							refreshToken: 'refresh-token',
							expiresAt: clock.now() + 3_600_000,
							projectId: 'proj-123',
						},
					],
				}),
			},
		});
		const fetch = vi.fn(async () => jsonResponse(AUTHORIZED_RESPONSE));
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: HOME,
			fetch: fetch as any,
			...snapshot,
		});
		const providers: Array<{ getServiceName(): string; getUsage(): Promise<any> }> = [];

		await provider.discoverQuotaGroups((usageProvider) => {
			providers.push(usageProvider as any);
		});
		fetch.mockRejectedValueOnce(new Error('network'));

		const claudeProvider = providers.find(item => item.getServiceName() === 'Antigravity Claude');
		const usage = await claudeProvider?.getUsage();

		expect(usage).toMatchObject({
			serviceName: 'Antigravity Claude',
			totalUsed: 30,
			models: [
				expect.objectContaining({
					modelName: 'Claude 3.7 Sonnet',
				}),
			],
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
