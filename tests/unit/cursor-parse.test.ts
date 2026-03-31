import { describe, expect, it } from 'vitest';
import { parseCursorUsageResponse } from '../../src/providers/cursor-parse';

describe('parseCursorUsageResponse', () => {
	it('maps Cursor spend and split buckets into usage data', () => {
		const result = parseCursorUsageResponse({
			billingCycleEnd: Date.parse('2026-04-01T00:00:00.000Z'),
			planUsage: {
				includedSpend: 1234,
				limit: 2000,
				autoPercentUsed: 42,
				apiPercentUsed: 15,
			},
		}, {
			hasAutoSpillover: true,
		});

		expect(result).toMatchObject({
			serviceId: 'cursor',
			serviceName: 'Cursor',
			totalUsed: 12.34,
			totalLimit: 20,
			quotaWindows: [
				{ label: 'Auto + Composer', used: 42, limit: 100 },
				{ label: 'API', used: 15, limit: 100 },
			],
		});
		expect(result?.resetTime?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
	});

	it('returns null when required plan usage fields are missing', () => {
		expect(parseCursorUsageResponse({ planUsage: { includedSpend: 200 } }, null)).toBeNull();
		expect(parseCursorUsageResponse({}, null)).toBeNull();
	});
});
