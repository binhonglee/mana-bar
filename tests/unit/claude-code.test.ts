import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from '../../src/providers/claude-code';
import { FixedClock } from '../support/provider-test-utils';

const SUCCESS_RESPONSE = {
	five_hour: {
		utilization: 35,
		resets_at: '2026-03-10T18:00:00.000Z',
	},
	seven_day: {
		utilization: 65,
		resets_at: '2026-03-12T18:00:00.000Z',
	},
};

describe('ClaudeCodeProvider', () => {
	it('prefers the macOS keychain token over file credentials', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const request = vi.fn(async () => ({
			statusCode: 200,
			body: JSON.stringify(SUCCESS_RESPONSE),
		}));
		const provider = new ClaudeCodeProvider({
			now: clock.now,
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec: async () => ({
				stdout: JSON.stringify({
					claudeAiOauth: {
						accessToken: 'keychain-token',
					},
				}),
			}),
			readJsonFile: async () => ({
				claudeAiOauth: {
					accessToken: 'file-token',
					refreshToken: 'refresh',
					expiresAt: clock.now() + 60_000,
				},
			}),
			request,
		});

		const usage = await provider.getUsage();

		expect(usage?.totalUsed).toBe(65);
		expect(request).toHaveBeenCalledWith(expect.objectContaining({
			headers: expect.objectContaining({
				Authorization: 'Bearer keychain-token',
			}),
		}));
	});

	it('falls back to file credentials when keychain lookup fails', async () => {
		const request = vi.fn(async () => ({
			statusCode: 200,
			body: JSON.stringify(SUCCESS_RESPONSE),
		}));
		const provider = new ClaudeCodeProvider({
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('missing keychain');
			},
			readJsonFile: async () => ({
				claudeAiOauth: {
					accessToken: 'file-token',
					refreshToken: 'refresh',
					expiresAt: Date.now() + 60_000,
				},
			}),
			request,
		});

		await provider.getUsage();

		expect(request).toHaveBeenCalledWith(expect.objectContaining({
			headers: expect.objectContaining({
				Authorization: 'Bearer file-token',
			}),
		}));
	});

	it('reports unavailable when the Claude directory or token is missing', async () => {
		const missingDir = new ClaudeCodeProvider({
			fileExists: async () => false,
		});
		const missingToken = new ClaudeCodeProvider({
			fileExists: async () => true,
			platform: 'linux',
			readJsonFile: async () => null,
		});

		await expect(missingDir.isAvailable()).resolves.toBe(false);
		await expect(missingToken.isAvailable()).resolves.toBe(false);
		await expect(missingToken.getUsage()).resolves.toBeNull();
	});

	it('returns cached data on 429 responses after the cache expires', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const request = vi.fn(async () => ({
			statusCode: 200,
			body: JSON.stringify(SUCCESS_RESPONSE),
		}));
		const provider = new ClaudeCodeProvider({
			now: clock.now,
			platform: 'linux',
			fileExists: async () => true,
			readJsonFile: async () => ({
				claudeAiOauth: {
					accessToken: 'file-token',
					refreshToken: 'refresh',
					expiresAt: clock.now() + 60_000,
				},
			}),
			request,
		});

		const first = await provider.getUsage();
		clock.advance(181_000);
		request.mockResolvedValueOnce({
			statusCode: 429,
			body: '',
		});

		const second = await provider.getUsage();

		expect(second).toEqual(first);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('returns stale cached data when the API request throws', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const request = vi.fn(async () => ({
			statusCode: 200,
			body: JSON.stringify(SUCCESS_RESPONSE),
		}));
		const provider = new ClaudeCodeProvider({
			now: clock.now,
			platform: 'linux',
			fileExists: async () => true,
			readJsonFile: async () => ({
				claudeAiOauth: {
					accessToken: 'file-token',
					refreshToken: 'refresh',
					expiresAt: clock.now() + 60_000,
				},
			}),
			request,
		});

		const first = await provider.getUsage();
		clock.advance(181_000);
		request.mockRejectedValueOnce(new Error('network'));

		const second = await provider.getUsage();

		expect(second).toEqual(first);
	});
});
