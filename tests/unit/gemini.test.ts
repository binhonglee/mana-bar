import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'url';
import { GeminiProvider } from '../../src/providers/gemini';
import { FixedClock, jsonResponse } from '../support/provider-test-utils';

const HOME = '/Users/test';
const GEMINI_DIR = `${HOME}/.gemini`;
const SETTINGS_FILE = `${GEMINI_DIR}/settings.json`;
const CREDENTIALS_FILE = `${GEMINI_DIR}/oauth_creds.json`;
const BINARY_PATH = '/opt/homebrew/bin/gemini';
const PACKAGE_ROOT = '/opt/homebrew/libexec/lib/node_modules/@google/gemini-cli';
const MODELS_FILE = `${PACKAGE_ROOT}/node_modules/@google/gemini-cli-core/dist/src/config/models.js`;
const DEFAULT_CONFIGS_FILE = `${PACKAGE_ROOT}/node_modules/@google/gemini-cli-core/dist/src/config/defaultModelConfigs.js`;

function createReadJsonFile(overrides?: {
	settings?: unknown;
	credentials?: unknown;
}) {
	return async <T>(filePath: string): Promise<T | null> => {
		if (filePath === SETTINGS_FILE) {
			return (overrides?.settings ?? {
				security: {
					auth: {
						selectedType: 'oauth-personal',
					},
				},
			}) as T;
		}
		if (filePath === CREDENTIALS_FILE) {
			return (overrides?.credentials ?? null) as T;
		}
		return null;
	};
}

function createFileExists(paths: string[]) {
	const allowed = new Set(paths);
	return async (filePath: string): Promise<boolean> => allowed.has(filePath);
}

describe('GeminiProvider', () => {
	it('is unavailable when Gemini is configured for a non-OAuth auth type', async () => {
		const provider = new GeminiProvider({
			homeDir: HOME,
			exec: async () => ({ stdout: `${BINARY_PATH}\n` }),
			realpath: async () => BINARY_PATH,
			fileExists: createFileExists([GEMINI_DIR]),
			readJsonFile: createReadJsonFile({
				settings: {
					security: {
						auth: {
							selectedType: 'api-key',
						},
					},
				},
			}),
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('prefers keychain credentials and discovers models from VALID_GEMINI_MODELS', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).not.toBe('https://oauth2.googleapis.com/token');
			expect(init?.headers).toMatchObject({
				Authorization: 'Bearer keychain-token',
			});
			if (url.endsWith(':loadCodeAssist')) {
				return jsonResponse({
					currentTier: { id: 'pro' },
					cloudaicompanionProject: 'proj-123',
				});
			}
			return jsonResponse({
				buckets: [
					{
						modelId: 'gemini-2.5-pro',
						tokenType: 'REQUESTS',
						remainingFraction: 0.82,
						resetTime: '2026-03-10T18:00:00.000Z',
					},
				],
			});
		});
		const provider = new GeminiProvider({
			now: clock.now,
			homeDir: HOME,
			platform: 'darwin',
			exec: async (command) => {
				if (command === 'which gemini') {
					return { stdout: `${BINARY_PATH}\n` };
				}
				return {
					stdout: JSON.stringify({
						token: {
							accessToken: 'keychain-token',
							refreshToken: 'keychain-refresh',
							expiresAt: clock.now() + 3_600_000,
						},
					}),
				};
			},
			realpath: async () => BINARY_PATH,
			fileExists: createFileExists([GEMINI_DIR, MODELS_FILE]),
			readJsonFile: createReadJsonFile({
				credentials: {
					access_token: 'file-token',
				},
			}),
			importModule: async (specifier) => {
				expect(specifier).toBe(pathToFileURL(MODELS_FILE).href);
				return {
					VALID_GEMINI_MODELS: new Set(['gemini-2.5-pro', 'not-a-gemini-model']),
				};
			},
			fetch: fetch as any,
		});
		const registered: Array<{ getServiceName(): string; getUsage(): Promise<any> }> = [];

		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider as any);
		});

		expect(registered.map(item => item.getServiceName())).toEqual(['Gemini CLI 2.5 Pro']);
		await expect(registered[0]?.getUsage()).resolves.toMatchObject({
			serviceName: 'Gemini CLI 2.5 Pro',
			totalUsed: 18,
		});
	});

	it('refreshes expired file credentials and falls back to defaultModelConfigs discovery', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async (url: string) => {
			if (url === 'https://oauth2.googleapis.com/token') {
				return jsonResponse({
					access_token: 'refreshed-token',
				});
			}
			if (url.endsWith(':loadCodeAssist')) {
				return jsonResponse({
					currentTier: { id: 'pro' },
					cloudaicompanionProject: 'proj-123',
				});
			}
			return jsonResponse({
				buckets: [
					{
						modelId: 'gemini-2.5-flash',
						tokenType: 'REQUESTS',
						remainingFraction: 0.55,
						resetTime: '2026-03-10T15:00:00.000Z',
					},
				],
			});
		});
		const provider = new GeminiProvider({
			now: clock.now,
			homeDir: HOME,
			platform: 'linux',
			exec: async () => ({ stdout: `${BINARY_PATH}\n` }),
			realpath: async () => BINARY_PATH,
			fileExists: createFileExists([GEMINI_DIR, DEFAULT_CONFIGS_FILE]),
			readJsonFile: createReadJsonFile({
				credentials: {
					access_token: 'expired-token',
					refresh_token: 'refresh-token',
					expiry_date: clock.now() - 5_000,
				},
			}),
			importModule: async (specifier) => {
				expect(specifier).toBe(pathToFileURL(DEFAULT_CONFIGS_FILE).href);
				return {
					DEFAULT_MODEL_CONFIGS: {
						aliases: {
							'gemini-2.5-flash': {
								modelConfig: {
									model: 'gemini-2.5-flash',
								},
							},
						},
					},
				};
			},
			fetch: fetch as any,
		});
		const registered: Array<{ getServiceName(): string; getUsage(): Promise<any> }> = [];

		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider as any);
		});

		expect(registered.map(item => item.getServiceName())).toEqual(['Gemini CLI 2.5 Flash']);
		await expect(registered[0]?.getUsage()).resolves.toMatchObject({
			totalUsed: 45,
		});
		expect(fetch.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/token');
	});

	it('falls back to raw quota buckets when CLI config files are missing', async () => {
		const provider = new GeminiProvider({
			homeDir: HOME,
			platform: 'linux',
			exec: async () => ({ stdout: `${BINARY_PATH}\n` }),
			realpath: async () => BINARY_PATH,
			fileExists: createFileExists([GEMINI_DIR]),
			readJsonFile: createReadJsonFile({
				credentials: {
					access_token: 'live-token',
					expiry_date: Date.parse('2026-03-10T20:00:00.000Z'),
				},
			}),
			fetch: vi.fn(async (url: string) => {
				if (url.endsWith(':loadCodeAssist')) {
					return jsonResponse({
						currentTier: { id: 'pro' },
						cloudaicompanionProject: 'proj-123',
					});
				}
				return jsonResponse({
					buckets: [
						{
							modelId: 'gemini-2.5-pro',
							tokenType: 'TOKENS',
							remainingFraction: 0.2,
						},
						{
							modelId: 'gemini-2.5-pro',
							tokenType: 'REQUESTS',
							remainingFraction: 0.8,
						},
						{
							modelId: 'gemini-2.5-flash',
							tokenType: 'REQUESTS',
							remainingFraction: 0.6,
						},
					],
				});
			}) as any,
		});
		const registered: string[] = [];

		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider.getServiceName());
		});

		expect(registered).toEqual([
			'Gemini CLI 2.5 Pro',
			'Gemini CLI 2.5 Flash',
		]);
	});

	it('returns cached quota data when later refreshes fail', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith(':loadCodeAssist')) {
				return jsonResponse({
					currentTier: { id: 'pro' },
					cloudaicompanionProject: 'proj-123',
				});
			}
			return jsonResponse({
				buckets: [
					{
						modelId: 'gemini-2.5-pro',
						tokenType: 'REQUESTS',
						remainingFraction: 0.7,
						resetTime: '2026-03-10T18:00:00.000Z',
					},
				],
			});
		});
		const provider = new GeminiProvider({
			now: clock.now,
			homeDir: HOME,
			platform: 'linux',
			exec: async () => ({ stdout: `${BINARY_PATH}\n` }),
			realpath: async () => BINARY_PATH,
			fileExists: createFileExists([GEMINI_DIR, MODELS_FILE]),
			readJsonFile: createReadJsonFile({
				credentials: {
					access_token: 'live-token',
					expiry_date: clock.now() + 3_600_000,
				},
			}),
			importModule: async () => ({
				VALID_GEMINI_MODELS: new Set(['gemini-2.5-pro']),
			}),
			fetch: fetch as any,
		});
		const registered: Array<{ getUsage(): Promise<any> }> = [];

		await provider.discoverQuotaGroups((usageProvider) => {
			registered.push(usageProvider as any);
		});

		const first = await registered[0]?.getUsage();
		clock.advance(181_000);
		fetch.mockRejectedValueOnce(new Error('network'));
		const second = await registered[0]?.getUsage();

		expect(second).toMatchObject({
			serviceName: first?.serviceName,
			totalUsed: first?.totalUsed,
			totalLimit: first?.totalLimit,
		});
	});
});
