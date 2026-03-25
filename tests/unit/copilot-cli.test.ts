import { describe, expect, it, vi } from 'vitest';
import { CopilotCliProvider } from '../../src/providers/copilot-cli';
import { FixedClock } from '../support/provider-test-utils';

const SUCCESS_RESPONSE = {
	quota_snapshots: {
		chat: {
			entitlement: 100,
			percent_remaining: 35,
			remaining: 35,
		},
	},
	quota_reset_date: '2026-03-15T00:00:00.000Z',
};

const UNLIMITED_RESPONSE = {
	quota_snapshots: {
		chat: {
			entitlement: -1,
			percent_remaining: 100,
			unlimited: true,
		},
	},
};

describe('CopilotCliProvider', () => {
	it('prefers the macOS keychain token over hosts.json', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const provider = new CopilotCliProvider({
			now: clock.now,
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec: async () => ({
				stdout: 'keychain-token',
			}),
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
		});

		const usage = await provider.getUsage();

		expect(usage?.totalUsed).toBe(65);
		expect(usage?.totalLimit).toBe(100);
		expect(fetch).toHaveBeenCalledWith(
			'https://api.github.com/copilot_internal/user',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer keychain-token',
				}),
			})
		);
	});

	it('falls back to hosts.json when keychain lookup fails', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const provider = new CopilotCliProvider({
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('missing keychain');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
		});

		await provider.getUsage();

		expect(fetch).toHaveBeenCalledWith(
			'https://api.github.com/copilot_internal/user',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer file-token',
				}),
			})
		);
	});

	it('reports unavailable when the copilot directory is missing', async () => {
		const provider = new CopilotCliProvider({
			fileExists: async () => false,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('reports unavailable when config.json has no logged_in_users', async () => {
		const provider = new CopilotCliProvider({
			fileExists: async () => true,
			readJsonFile: async () => ({ logged_in_users: [] }),
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('reports unavailable when no token can be found', async () => {
		const provider = new CopilotCliProvider({
			platform: 'linux',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('secret-tool not found');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				// No hosts.json
				return null;
			},
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
		await expect(provider.getUsage()).resolves.toBeNull();
	});

	it('returns cached data on 429 responses after cache expires', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const provider = new CopilotCliProvider({
			now: clock.now,
			platform: 'linux',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('secret-tool not found');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
		});

		const first = await provider.getUsage();
		clock.advance(181_000);
		fetch.mockResolvedValueOnce(new Response('', { status: 429 }));

		const second = await provider.getUsage();

		expect(second).toEqual(first);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('returns stale cached data when the API request throws', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const provider = new CopilotCliProvider({
			now: clock.now,
			platform: 'linux',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('secret-tool not found');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
		});

		const first = await provider.getUsage();
		clock.advance(181_000);
		fetch.mockRejectedValueOnce(new Error('network'));

		const second = await provider.getUsage();

		expect(second).toEqual(first);
	});

	it('returns null for unlimited quota', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(UNLIMITED_RESPONSE), { status: 200 }));
		const provider = new CopilotCliProvider({
			platform: 'linux',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('secret-tool not found');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
	});

	it('uses Linux secret-tool when available', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const exec = vi.fn(async () => ({ stdout: 'secret-tool-token\n' }));
		const provider = new CopilotCliProvider({
			platform: 'linux',
			homeDir: '/home/test',
			fileExists: async () => true,
			exec,
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
		});

		await provider.getUsage();

		expect(exec).toHaveBeenCalledWith(
			expect.stringContaining('secret-tool lookup service copilot-cli')
		);
		expect(fetch).toHaveBeenCalledWith(
			'https://api.github.com/copilot_internal/user',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer secret-tool-token',
				}),
			})
		);
	});

	it('parses quota windows from response', async () => {
		const responseWithWindows = {
			quota_snapshots: {
				chat: {
					entitlement: 100,
					percent_remaining: 50,
					remaining: 50,
				},
				completions: {
					entitlement: 200,
					percent_remaining: 75,
					remaining: 150,
				},
			},
			quota_reset_date: '2026-03-15T00:00:00.000Z',
		};
		const fetch = vi.fn(async () => new Response(JSON.stringify(responseWithWindows), { status: 200 }));
		const provider = new CopilotCliProvider({
			platform: 'linux',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('secret-tool not found');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
		});

		const usage = await provider.getUsage();

		expect(usage?.quotaWindows).toBeDefined();
		expect(usage?.quotaWindows?.length).toBeGreaterThan(0);
	});
});
