import { describe, expect, it, vi } from 'vitest';
import { CursorProvider } from '../../src/providers/cursor';

const usagePayload = {
	billingCycleEnd: Date.parse('2026-04-01T00:00:00.000Z'),
	planUsage: {
		includedSpend: 300,
		limit: 1000,
		autoPercentUsed: 30,
		apiPercentUsed: 10,
	},
};

describe('CursorProvider', () => {
	it('is available when access token is provided via environment', async () => {
		const provider = new CursorProvider({
			env: { MANA_BAR_CURSOR_ACCESS_TOKEN: 'cursor-token' },
			fetch: vi.fn(async () => new Response(JSON.stringify({}))) as unknown as typeof fetch,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
	});

	it('fetches usage and caches responses', async () => {
		const now = vi.fn(() => Date.parse('2026-03-10T10:00:00.000Z'));
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/aiserver.v1.DashboardService/GetCurrentPeriodUsage')) {
				return new Response(JSON.stringify(usagePayload));
			}
			if (url.endsWith('/aiserver.v1.DashboardService/IsOnNewPricing')) {
				return new Response(JSON.stringify({ hasAutoSpillover: true }));
			}
			return new Response('{}', { status: 404 });
		});

		const provider = new CursorProvider({
			now,
			env: { MANA_BAR_CURSOR_ACCESS_TOKEN: 'cursor-token' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();
		const second = await provider.getUsage();

		expect(first?.serviceId).toBe('cursor');
		expect(first?.totalUsed).toBe(30); // Critical percentage (auto > api)
		expect(first?.totalLimit).toBe(100);
		expect(first?.quotaWindows?.map(window => window.label)).toEqual(['Spend', 'Auto + Composer', 'API']);
		expect(second).toEqual(first);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('falls back to the cursor-agent CLI keychain token when the editor DB has none', async () => {
		const exec = vi.fn(async (command: string) => {
			if (command.startsWith('security find-generic-password')) {
				return { stdout: 'cli-keychain-token\n' };
			}
			// editor sqlite lookup returns nothing (no editor installed)
			return { stdout: '' };
		});

		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/aiserver.v1.DashboardService/GetCurrentPeriodUsage')) {
				expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cli-keychain-token');
				return new Response(JSON.stringify(usagePayload));
			}
			if (url.endsWith('/aiserver.v1.DashboardService/IsOnNewPricing')) {
				return new Response(JSON.stringify({ hasAutoSpillover: true }));
			}
			return new Response('{}', { status: 404 });
		});

		const provider = new CursorProvider({
			platform: 'darwin',
			env: {},
			exec,
			readStateDbValue: vi.fn(async () => null),
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
		const usage = await provider.getUsage();
		expect(usage?.serviceId).toBe('cursor');
		expect(exec).toHaveBeenCalledWith(
			expect.stringMatching(/security find-generic-password .*cursor-access-token.*cursor-user/)
		);
	});

	it('reads the CLI keychain via secret-tool on Linux', async () => {
		const exec = vi.fn(async (command: string) => {
			if (command.startsWith('secret-tool lookup')) {
				return { stdout: 'linux-secret-token\n' };
			}
			return { stdout: '' };
		});

		const provider = new CursorProvider({
			platform: 'linux',
			env: {},
			exec,
			readStateDbValue: vi.fn(async () => null),
			fetch: vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith('/aiserver.v1.DashboardService/GetCurrentPeriodUsage')) {
					return new Response(JSON.stringify(usagePayload));
				}
				return new Response('{}', { status: 404 });
			}) as unknown as typeof fetch,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
		expect(exec).toHaveBeenCalledWith(
			expect.stringMatching(/secret-tool lookup service cursor-access-token account cursor-user/)
		);
	});

	it('does not shell out to the keychain on unsupported platforms', async () => {
		const exec = vi.fn(async () => ({ stdout: '' }));
		const provider = new CursorProvider({
			platform: 'win32',
			env: {},
			exec,
			readStateDbValue: vi.fn(async () => null),
			fetch: vi.fn(async () => new Response('{}')) as unknown as typeof fetch,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
		// Windows has no portable keychain lookup: only the editor sqlite path may run.
		for (const [command] of exec.mock.calls) {
			expect(command).not.toMatch(/security find-generic-password|secret-tool/);
		}
	});

	it('falls back to the bundled SQLite reader when the sqlite3 CLI is unavailable', async () => {
		const provider = new CursorProvider({
			platform: 'win32',
			env: {},
			exec: vi.fn(async () => {
				throw new Error('sqlite3 missing');
			}),
			readStateDbValue: vi.fn(async () => 'cursor-token'),
			fetch: vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith('/aiserver.v1.DashboardService/GetCurrentPeriodUsage')) {
					return new Response(JSON.stringify(usagePayload));
				}
				if (url.endsWith('/aiserver.v1.DashboardService/IsOnNewPricing')) {
					return new Response(JSON.stringify({ hasAutoSpillover: true }));
				}
				return new Response('{}', { status: 404 });
			}) as unknown as typeof fetch,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
		const usage = await provider.getUsage();
		expect(usage?.serviceId).toBe('cursor');
	});
});
