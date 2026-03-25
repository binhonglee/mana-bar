import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CopilotCliProvider, SecretStorageLike } from '../../src/providers/copilot-cli';
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

function createMockSecrets(): SecretStorageLike & { stored: Map<string, string> } {
	const stored = new Map<string, string>();
	return {
		stored,
		get: vi.fn(async (key: string) => stored.get(key)),
		store: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
		delete: vi.fn(async (key: string) => { stored.delete(key); }),
	};
}

function createMockContext(secrets?: SecretStorageLike): vscode.ExtensionContext {
	return {
		secrets: secrets ?? createMockSecrets(),
		subscriptions: [],
		extensionUri: vscode.Uri.file('/test-extension'),
	} as unknown as vscode.ExtensionContext;
}

describe('CopilotCliProvider', () => {
	it('stores token in SecretStorage after keychain lookup', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const exec = vi.fn(async () => ({ stdout: 'keychain-token\n' }));
		const secrets = createMockSecrets();
		const provider = new CopilotCliProvider(createMockContext(secrets), {
			now: clock.now,
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec,
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
		});

		await provider.getUsage();

		// Token should be stored in SecretStorage
		expect(secrets.store).toHaveBeenCalledWith('copilotCliToken', 'keychain-token');
		expect(secrets.stored.get('copilotCliToken')).toBe('keychain-token');
	});

	it('uses SecretStorage token without hitting keychain', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const exec = vi.fn(async () => ({ stdout: 'keychain-token\n' }));
		const secrets = createMockSecrets();
		// Pre-populate secret storage
		secrets.stored.set('copilotCliToken', 'stored-token');

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			now: clock.now,
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec,
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
		});

		await provider.getUsage();

		// Should NOT call keychain
		expect(exec).not.toHaveBeenCalled();
		// Should use stored token
		expect(fetch).toHaveBeenCalledWith(
			'https://api.github.com/copilot_internal/user',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer stored-token',
				}),
			})
		);
	});

	it('clears stored token when user logs out', async () => {
		const secrets = createMockSecrets();
		secrets.stored.set('copilotCliToken', 'old-token');

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			platform: 'darwin',
			fileExists: async () => true,
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					// No logged_in_users = logged out
					return { logged_in_users: [] };
				}
				return null;
			},
			secrets,
		});

		await provider.getUsage();

		// Token should be cleared
		expect(secrets.delete).toHaveBeenCalledWith('copilotCliToken');
	});

	it('falls back to keychain when SecretStorage is empty', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const exec = vi.fn(async () => ({ stdout: 'keychain-token\n' }));
		const secrets = createMockSecrets();

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec,
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
		});

		await provider.getUsage();

		// Should call keychain since SecretStorage was empty
		expect(exec).toHaveBeenCalledWith(
			expect.stringContaining('-a "https://github.com:testuser"')
		);
	});

	it('falls back to hosts.json when keychain fails', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const secrets = createMockSecrets();

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			platform: 'darwin',
			homeDir: '/Users/test',
			fileExists: async () => true,
			exec: async () => {
				throw new Error('keychain error');
			},
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				if (path.endsWith('hosts.json')) {
					return {
						'https://github.com': { oauth_token: 'file-token' },
					};
				}
				return null;
			},
			fetch,
			secrets,
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
		const provider = new CopilotCliProvider(createMockContext(), {
			fileExists: async () => false,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('reports unavailable when config.json has no logged_in_users', async () => {
		const provider = new CopilotCliProvider(createMockContext(), {
			fileExists: async () => true,
			readJsonFile: async () => ({ logged_in_users: [] }),
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('returns cached data on 429 responses after cache expires', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(SUCCESS_RESPONSE), { status: 200 }));
		const secrets = createMockSecrets();
		secrets.stored.set('copilotCliToken', 'token');

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			now: clock.now,
			platform: 'darwin',
			fileExists: async () => true,
			exec: async () => ({ stdout: '' }),
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
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
		const secrets = createMockSecrets();
		secrets.stored.set('copilotCliToken', 'token');

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			now: clock.now,
			platform: 'darwin',
			fileExists: async () => true,
			exec: async () => ({ stdout: '' }),
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
		});

		const first = await provider.getUsage();
		clock.advance(181_000);
		fetch.mockRejectedValueOnce(new Error('network'));

		const second = await provider.getUsage();

		expect(second).toEqual(first);
	});

	it('returns null for unlimited quota', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(UNLIMITED_RESPONSE), { status: 200 }));
		const secrets = createMockSecrets();
		secrets.stored.set('copilotCliToken', 'token');

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			platform: 'darwin',
			fileExists: async () => true,
			exec: async () => ({ stdout: '' }),
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
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
		const secrets = createMockSecrets();
		secrets.stored.set('copilotCliToken', 'token');

		const provider = new CopilotCliProvider(createMockContext(secrets), {
			platform: 'darwin',
			fileExists: async () => true,
			exec: async () => ({ stdout: '' }),
			readJsonFile: async (path: string) => {
				if (path.endsWith('config.json')) {
					return {
						logged_in_users: [{ host: 'https://github.com', login: 'testuser' }],
					};
				}
				return null;
			},
			fetch,
			secrets,
		});

		const usage = await provider.getUsage();

		expect(usage?.quotaWindows).toBeDefined();
		expect(usage?.quotaWindows?.length).toBeGreaterThan(0);
	});
});
