import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../../src/providers/gemini';
import { AntigravityProvider } from '../../src/providers/antigravity';
import { jsonResponse } from '../support/provider-test-utils';
import * as vscode from 'vscode';

describe('Provider Resilience', () => {
	describe('GeminiProvider', () => {
		it('handles 401 Unauthorized by returning null (no cache)', async () => {
			const fetch = vi.fn(async (url: string) => {
				if (url.endsWith(':loadCodeAssist')) {
					return new Response('Unauthorized', { status: 401 });
				}
				return jsonResponse({});
			});

			const provider = new GeminiProvider({
				homeDir: '/test',
				exec: async (cmd) => {
					if (cmd === 'which gemini') return { stdout: '/bin/gemini' };
					return { stdout: JSON.stringify({ token: { accessToken: 'token', expiresAt: Date.now() + 10000 } }) };
				},
				realpath: async (p) => p,
				fileExists: async () => true,
				readJsonFile: async () => ({ security: { auth: { selectedType: 'oauth-personal' } } }),
				fetch: fetch as any,
			});

			// We need to trigger discovery first to get sub-providers
			const registered: any[] = [];
			// Mocking getQuotaResponse internal call via discoverQuotaGroups
			// Actually, let's just test getQuotaBucketForModel directly if possible, or discoverQuotaGroups
			await provider.discoverQuotaGroups((p) => registered.push(p));

			// If loadCodeAssist fails with 401, discoverQuotaGroups should handle it
			expect(registered.length).toBe(0);
		});

		it('handles 403 Forbidden by returning null', async () => {
			const fetch = vi.fn(async (url: string) => {
				if (url.endsWith(':loadCodeAssist')) {
					return jsonResponse({
						currentTier: { id: 'pro' },
						cloudaicompanionProject: 'proj-123',
					});
				}
				if (url.endsWith(':retrieveUserQuota')) {
					return new Response('Forbidden', { status: 403 });
				}
				return jsonResponse({});
			});

			const provider = new GeminiProvider({
				homeDir: '/test',
				exec: async (cmd) => {
					if (cmd === 'which gemini') return { stdout: '/bin/gemini' };
					return { stdout: JSON.stringify({ token: { accessToken: 'token', expiresAt: Date.now() + 10000 } }) };
				},
				realpath: async (p) => p,
				fileExists: async () => true,
				readJsonFile: async () => ({ security: { auth: { selectedType: 'oauth-personal' } } }),
				fetch: fetch as any,
			});

			const registered: any[] = [];
			await provider.discoverQuotaGroups((p) => registered.push(p));

			// Discovery should fail because retrieveUserQuota fails
			expect(registered.length).toBe(0);
		});
	});

	describe('AntigravityProvider', () => {
		it('handles 401 Unauthorized by clearing account and returning null', async () => {
			const fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
			const mockContext = { globalState: { get: vi.fn(), update: vi.fn() } } as any;

			const provider = new AntigravityProvider(mockContext, {
				homeDir: '/test',
				existsSync: () => true,
				readFileSync: (p) => {
					if (p.includes('credentials.json')) {
						return JSON.stringify({
							accounts: [{ email: 't@t.com', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 100000, projectId: 'p' }]
						});
					}
					return '';
				},
				fetch: fetch as any,
			});

			const registered: any[] = [];
			await provider.discoverQuotaGroups((p) => registered.push(p));

			expect(registered.length).toBe(0);
			expect(fetch).toHaveBeenCalled();
		});

		it('tries multiple endpoints and handles non-ok responses', async () => {
			const fetch = vi.fn()
				.mockResolvedValueOnce(new Response('Error', { status: 500 }))
				.mockResolvedValueOnce(jsonResponse({ models: { 'gemini-2.0-flash': { displayName: 'Gemini 2.0 Flash', quotaInfo: { remainingFraction: 0.5 } } } }));

			const mockContext = { globalState: { get: vi.fn(), update: vi.fn() } } as any;

			const provider = new AntigravityProvider(mockContext, {
				homeDir: '/test',
				existsSync: (p) => p.includes('credentials.json'),
				readFileSync: () => JSON.stringify({
					accounts: [{ email: 't@t.com', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 100000, projectId: 'p' }]
				}),
				fetch: fetch as any,
			});

			const registered: any[] = [];
			await provider.discoverQuotaGroups((p) => registered.push(p));

			expect(registered.length).toBe(1);
			expect(registered[0].getServiceName()).toBe('Antigravity Gemini Flash');
			expect(fetch).toHaveBeenCalledTimes(2);
		});
	});
});
