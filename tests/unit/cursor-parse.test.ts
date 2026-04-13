import { describe, expect, it } from 'vitest';
import { parseCursorUsageResponse } from '../../src/providers/cursor-parse';

describe('parseCursorUsageResponse', () => {
	it('selects critical percentage for totalUsed when hasAutoSpillover is true', () => {
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

		// totalUsed should be the critical (highest) percentage, not dollar spend
		expect(result).toMatchObject({
			serviceId: 'cursor',
			serviceName: 'Cursor',
			totalUsed: 42,
			totalLimit: 100,
			quotaWindows: [
				{ label: 'Spend', used: 12.34, limit: 20 },
				{ label: 'Auto + Composer', used: 42, limit: 100 },
				{ label: 'API', used: 15, limit: 100 },
			],
		});
		expect(result?.resetTime?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
	});

	it('selects API percentage when it is higher than Auto', () => {
		const result = parseCursorUsageResponse({
			planUsage: {
				includedSpend: 500,
				limit: 2000,
				autoPercentUsed: 25,
				apiPercentUsed: 80,
			},
		}, {
			hasAutoSpillover: true,
		});

		expect(result?.totalUsed).toBe(80);
		expect(result?.totalLimit).toBe(100);
	});

	it('uses dollar spend for totalUsed when hasAutoSpillover is false', () => {
		const result = parseCursorUsageResponse({
			billingCycleEnd: Date.parse('2026-04-01T00:00:00.000Z'),
			planUsage: {
				includedSpend: 1234,
				limit: 2000,
			},
		}, {
			hasAutoSpillover: false,
		});

		expect(result).toMatchObject({
			serviceId: 'cursor',
			serviceName: 'Cursor',
			totalUsed: 12.34,
			totalLimit: 20,
		});
		expect(result?.quotaWindows).toBeUndefined();
	});

	it('rounds spend to 2 decimal places', () => {
		const result = parseCursorUsageResponse({
			planUsage: {
				includedSpend: 1234.567,
				limit: 2000.999,
				autoPercentUsed: 50,
			},
		}, {
			hasAutoSpillover: true,
		});

		expect(result?.quotaWindows?.[0]).toMatchObject({
			label: 'Spend',
			used: 12.35,
			limit: 20.01,
		});
	});

	it('handles only autoPercentUsed present', () => {
		const result = parseCursorUsageResponse({
			planUsage: {
				includedSpend: 500,
				limit: 2000,
				autoPercentUsed: 60,
			},
		}, {
			hasAutoSpillover: true,
		});

		expect(result?.totalUsed).toBe(60);
		expect(result?.quotaWindows).toHaveLength(2);
		expect(result?.quotaWindows?.[1].label).toBe('Auto + Composer');
	});

	it('handles only apiPercentUsed present', () => {
		const result = parseCursorUsageResponse({
			planUsage: {
				includedSpend: 500,
				limit: 2000,
				apiPercentUsed: 35,
			},
		}, {
			hasAutoSpillover: true,
		});

		expect(result?.totalUsed).toBe(35);
		expect(result?.quotaWindows).toHaveLength(2);
		expect(result?.quotaWindows?.[1].label).toBe('API');
	});

	it('returns null when required plan usage fields are missing', () => {
		expect(parseCursorUsageResponse({ planUsage: { includedSpend: 200 } }, null)).toBeNull();
		expect(parseCursorUsageResponse({}, null)).toBeNull();
	});
});
