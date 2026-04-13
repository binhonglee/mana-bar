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
});
