import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { AntigravityProvider } from '../../src/providers/antigravity';
import {
	createExtensionContext,
	createFsSnapshot,
	FixedClock,
	jsonResponse,
	textResponse,
} from '../support/provider-test-utils';

const HOME = path.join(process.platform === 'win32' ? 'C:' : path.sep, 'Users', 'test');
const CACHE_DIR = path.join(HOME, '.antigravity_cockpit', 'cache', 'quota_api_v1_plugin');
const CACHE_FILE = path.join(CACHE_DIR, 'authorized');
const CREDENTIALS_FILE = path.join(HOME, '.antigravity_cockpit', 'credentials.json');
const WINDOWS_HOME = path.join('C:', 'Users', 'test');

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
				[CACHE_DIR]: ['authorized'],
			},
			mtimes: {
				[CACHE_FILE]: 10,
			},
		});
		const fetch = vi.fn();
		const provider = new AntigravityProvider(createExtensionContext(), {
			homeDir: HOME,
			platform: 'linux',
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
			platform: 'linux',
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
			platform: 'linux',
			fetch: fetch as any,
			...snapshot,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('registers a health-only fallback on Windows when official Antigravity logs show authenticated API traffic', async () => {
		const clock = new FixedClock(Date.parse('2026-04-29T00:53:30.000Z'));
		const logsRoot = path.join(WINDOWS_HOME, 'AppData', 'Roaming', 'Antigravity', 'logs');
		const runDir = path.join(logsRoot, '20260429T005313');
		const antigravityLog = path.join(runDir, 'window1', 'exthost', 'google.antigravity', 'Antigravity.log');
		const snapshot = createFsSnapshot({
			files: {
				[antigravityLog]: [
					'2026-04-29 00:53:13.149 [info] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels Trace: 0x9f7abe7b40c36016',
					'2026-04-29 00:53:13.426 [info] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist Trace: 0xee487af73886fd6a',
				].join('\n'),
			},
			directories: {
				[logsRoot]: ['20260429T005313'],
				[runDir]: [],
			},
			mtimes: {
				[runDir]: clock.now(),
				[antigravityLog]: clock.now(),
			},
		});
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: WINDOWS_HOME,
			platform: 'win32',
			exec: vi.fn(async () => ({ stdout: '[]', stderr: '' })) as any,
			fetch: vi.fn() as any,
			...snapshot,
		});
		const registered: any[] = [];

		await expect(provider.isAvailable()).resolves.toBe(true);
		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider);
		});

		expect(registered).toHaveLength(1);
		expect(registered[0].getServiceName()).toBe('Antigravity');
		await expect(registered[0].getUsage()).resolves.toBeNull();
		expect(registered[0].getLastServiceHealth()).toMatchObject({
			kind: 'unavailable',
		});
	});

	it('registers a reauth fallback on Windows when Antigravity logs show a signed-out auth state', async () => {
		const clock = new FixedClock(Date.parse('2026-05-01T15:44:13.000Z'));
		const logsRoot = path.join(WINDOWS_HOME, 'AppData', 'Roaming', 'Antigravity', 'logs');
		const runDir = path.join(logsRoot, '20260501T084354');
		const authLog = path.join(runDir, 'auth.log');
		const lsMainLog = path.join(runDir, 'ls-main.log');
		const snapshot = createFsSnapshot({
			files: {
				[authLog]: '2026-05-01 08:43:55.113 [info] [Auth] Auth state changed to: signedOut',
				[lsMainLog]: '2026-05-01 08:43:56.373 [error] [LS Main stderr] E0501 08:43:56.357213 10804 server.go:544] Failed to get OAuth token: error getting token source from auth provider: state syncing error: key not found',
			},
			directories: {
				[logsRoot]: ['20260501T084354'],
				[runDir]: [],
			},
			mtimes: {
				[runDir]: clock.now(),
				[authLog]: clock.now(),
				[lsMainLog]: clock.now(),
			},
		});
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: WINDOWS_HOME,
			platform: 'win32',
			exec: vi.fn(async () => ({ stdout: '[]', stderr: '' })) as any,
			fetch: vi.fn() as any,
			...snapshot,
		});
		const registered: any[] = [];

		await expect(provider.isAvailable()).resolves.toBe(true);
		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider);
		});

		expect(registered).toHaveLength(1);
		expect(registered[0].getServiceName()).toBe('Antigravity');
		expect(registered[0].getLastServiceHealth()).toMatchObject({
			kind: 'reauthRequired',
		});
	});

	it('prefers the newest signed-in Antigravity run over older signed-out logs', async () => {
		const clock = new FixedClock(Date.parse('2026-05-01T16:07:00.000Z'));
		const logsRoot = path.join(WINDOWS_HOME, 'AppData', 'Roaming', 'Antigravity', 'logs');
		const latestRunDir = path.join(logsRoot, '20260501T090554');
		const olderRunDir = path.join(logsRoot, '20260501T084354');
		const latestAuthLog = path.join(latestRunDir, 'auth.log');
		const latestLsLog = path.join(latestRunDir, 'ls-main.log');
		const olderAuthLog = path.join(olderRunDir, 'auth.log');
		const olderLsLog = path.join(olderRunDir, 'ls-main.log');
		const snapshot = createFsSnapshot({
			files: {
				[latestAuthLog]: '2026-05-01 09:05:57.475 [info] [Auth] Auth state changed to: signedIn',
				[latestLsLog]: '2026-05-01 09:06:00.888 [info] I0501 09:06:00.887616 16080 http_helpers.go:151] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels Trace: 0xdcb745b865f2d996',
				[olderAuthLog]: '2026-05-01 08:43:55.113 [info] [Auth] Auth state changed to: signedOut',
				[olderLsLog]: '2026-05-01 08:43:56.373 [error] [LS Main stderr] E0501 08:43:56.357213 10804 server.go:544] Failed to get OAuth token: error getting token source from auth provider: state syncing error: key not found',
			},
			directories: {
				[logsRoot]: ['20260501T090554', '20260501T084354'],
				[latestRunDir]: [],
				[olderRunDir]: [],
			},
			mtimes: {
				[latestRunDir]: clock.now(),
				[latestAuthLog]: clock.now(),
				[latestLsLog]: clock.now(),
				[olderRunDir]: clock.now() - 60_000,
				[olderAuthLog]: clock.now() - 60_000,
				[olderLsLog]: clock.now() - 60_000,
			},
		});
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: WINDOWS_HOME,
			platform: 'win32',
			exec: vi.fn(async () => ({ stdout: '[]', stderr: '' })) as any,
			fetch: vi.fn() as any,
			...snapshot,
		});
		const registered: any[] = [];

		await expect(provider.isAvailable()).resolves.toBe(true);
		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider);
		});

		expect(registered).toHaveLength(1);
		expect(registered[0].getLastServiceHealth()).toMatchObject({
			kind: 'unavailable',
		});
	});

	it('uses the Antigravity auth session when local credentials are unavailable', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: WINDOWS_HOME,
			platform: 'win32',
			exec: vi.fn(async () => ({ stdout: '[]', stderr: '' })) as any,
			getAuthSession: vi.fn(async () => ({
				accessToken: 'session-token',
				scopes: [],
			})),
			fetch: vi.fn(async () => jsonResponse(AUTHORIZED_RESPONSE)) as any,
			...createFsSnapshot({}),
		});
		const registered: string[] = [];

		await expect(provider.isAvailable()).resolves.toBe(true);
		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider.getServiceName());
		});

		expect(registered).toEqual([
			'Antigravity Gemini Flash',
			'Antigravity Claude',
		]);
	});

	it('uses the Windows local language server when quota is exposed over localhost', async () => {
		const clock = new FixedClock(Date.parse('2026-04-30T03:45:13.000Z'));
		const exec = vi.fn(async (command: string) => {
			if (command.includes('Get-CimInstance Win32_Process')) {
				return {
					stdout: JSON.stringify([
						{
							ProcessId: 24096,
							CommandLine: 'C:\\Users\\test\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe --csrf_token 83aac6d0-3b33-46ba-a29e-bbd494b2ab3c --extension_server_port 60652 --app_data_dir antigravity',
						},
					]),
					stderr: '',
				};
			}
			if (command.includes('Get-NetTCPConnection')) {
				return {
					stdout: JSON.stringify([60654]),
					stderr: '',
				};
			}
			throw new Error(`Unexpected command: ${command}`);
		});
		const requestLocalStatus = vi.fn(async () => ({
			userStatus: {
				cascadeModelConfigData: {
					clientModelConfigs: [
						{
							label: 'Gemini 3.1 Pro (High)',
							modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
							quotaInfo: {
								remainingFraction: 1,
								resetTime: '2026-05-07T03:45:13Z',
							},
						},
						{
							label: 'Claude Sonnet 4.6 (Thinking)',
							modelOrAlias: { model: 'MODEL_PLACEHOLDER_M35' },
							quotaInfo: {
								remainingFraction: 0.6,
								resetTime: '2026-05-05T18:44:46Z',
							},
						},
					],
				},
			},
		}));
		const provider = new AntigravityProvider(createExtensionContext(), {
			now: clock.now,
			homeDir: WINDOWS_HOME,
			platform: 'win32',
			exec: exec as any,
			requestLocalStatus: requestLocalStatus as any,
			fetch: vi.fn() as any,
			...createFsSnapshot({}),
		});
		const registered: string[] = [];

		await expect(provider.isAvailable()).resolves.toBe(true);
		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider.getServiceName());
		});

		expect(registered).toEqual([
			'Antigravity Gemini Pro',
			'Antigravity Claude',
		]);
		expect(requestLocalStatus).toHaveBeenCalled();
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
			platform: 'linux',
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
			platform: 'linux',
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
