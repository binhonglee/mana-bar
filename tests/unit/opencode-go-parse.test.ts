import { describe, expect, it } from 'vitest';
import { findBlockedWindow, parseOpenCodeGoUsageResponse } from '../../src/providers/opencode-go-parse';

describe('parseOpenCodeGoUsageResponse', () => {
	it('maps every window into a percentage-based quota window', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-24T07:26:43.000Z' },
				weekly: { status: 'ok', percent: 5, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 19, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		}, 'OpenCode Go', new Date('2026-08-24T00:00:00.000Z'));

		expect(result.serviceId).toBe('opencodeGo');
		expect(result.serviceName).toBe('OpenCode Go');
		expect(result.totalLimit).toBe(100);
		expect(result.quotaWindows).toEqual([
			{ label: 'Rolling', used: 0, limit: 100, resetTime: new Date('2026-08-24T07:26:43.000Z') },
			{ label: 'Weekly', used: 5, limit: 100, resetTime: new Date('2026-08-31T00:00:00.000Z') },
			{ label: 'Monthly', used: 19, limit: 100, resetTime: new Date('2026-09-02T07:09:09.000Z') },
		]);
	});

	it('reports the most-constraining window as the total', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				rolling: { status: 'ok', percent: 80, resetsAt: '2026-08-24T07:26:43.000Z' },
				weekly: { status: 'ok', percent: 40, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 19, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(result.totalUsed).toBe(80);
		expect(result.resetTime).toEqual(new Date('2026-08-24T07:26:43.000Z'));
	});

	it('breaks ties on used percentage by the latest reset', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				weekly: { status: 'ok', percent: 50, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 50, resetsAt: '2026-09-02T00:00:00.000Z' },
			},
		});

		expect(result.totalUsed).toBe(50);
		expect(result.resetTime).toEqual(new Date('2026-09-02T00:00:00.000Z'));
	});

	it('keeps the first tied window when a later window has no reset time', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				weekly: { status: 'ok', percent: 50, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 50, resetsAt: 'not-a-date' },
			},
		});

		expect(result.totalUsed).toBe(50);
		expect(result.resetTime).toEqual(new Date('2026-08-31T00:00:00.000Z'));
	});

	it('selects the most-constrained window by raw percent, not the rounded value', () => {
		// Weekly has the higher raw percent (20.4) but resets earlier; monthly is
		// lower (19.6) but resets later. Both round to 20, so a rounded comparison
		// would tie and wrongly pick monthly on the later reset. The raw comparison
		// keeps weekly.
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				weekly: { status: 'ok', percent: 20.4, resetsAt: '2026-09-02T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 19.6, resetsAt: '2026-09-10T00:00:00.000Z' },
			},
		});

		expect(result.totalUsed).toBe(20);
		expect(result.resetTime).toEqual(new Date('2026-09-02T00:00:00.000Z'));
	});

	it('skips windows whose percent is not a finite number', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				rolling: { status: 'ok', percent: Number.NaN, resetsAt: '2026-08-24T07:26:43.000Z' },
				weekly: { status: 'ok', percent: Number.POSITIVE_INFINITY, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 40, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(result.quotaWindows).toHaveLength(1);
		expect(result.quotaWindows?.[0].label).toBe('Monthly');
		expect(result.totalUsed).toBe(40);
	});

	it('clamps percentages into the 0..100 range', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				rolling: { status: 'ok', percent: -5, resetsAt: '2026-08-24T07:26:43.000Z' },
				monthly: { status: 'ok', percent: 130, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(result.quotaWindows?.map((window) => window.used)).toEqual([0, 100]);
		expect(result.totalUsed).toBe(100);
	});

	it('rounds fractional percentages', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				monthly: { status: 'ok', percent: 19.6, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(result.totalUsed).toBe(20);
		expect(result.quotaWindows?.[0].used).toBe(20);
	});

	it('skips windows that are missing or lack a percentage', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				rolling: null,
				weekly: { status: 'ok' } as never,
				monthly: { status: 'ok', percent: 10, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(result.quotaWindows).toHaveLength(1);
		expect(result.quotaWindows?.[0].label).toBe('Monthly');
	});

	it('returns a zero total and no windows for an empty usage object', () => {
		const result = parseOpenCodeGoUsageResponse({ usage: {} });

		expect(result.totalUsed).toBe(0);
		expect(result.quotaWindows).toBeUndefined();
		expect(result.resetTime).toBeUndefined();
	});

	it('drops an invalid reset date but keeps the window', () => {
		const result = parseOpenCodeGoUsageResponse({
			usage: {
				monthly: { status: 'ok', percent: 10, resetsAt: 'not-a-date' },
			},
		});

		expect(result.quotaWindows?.[0].resetTime).toBeUndefined();
	});
});

describe('findBlockedWindow', () => {
	it('returns the first window whose status is not ok', () => {
		const blocked = findBlockedWindow({
			usage: {
				rolling: { status: 'ok', percent: 10, resetsAt: '2026-08-24T07:26:43.000Z' },
				weekly: { status: 'exceeded', percent: 100, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'blocked', percent: 100, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(blocked).toEqual({ label: 'Weekly', status: 'exceeded' });
	});

	it('returns null when every window is ok', () => {
		const blocked = findBlockedWindow({
			usage: {
				rolling: { status: 'ok', percent: 10, resetsAt: '2026-08-24T07:26:43.000Z' },
				monthly: { status: 'ok', percent: 40, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(blocked).toBeNull();
	});

	it('ignores a blocked status on a window the parser drops for a non-finite percent', () => {
		const blocked = findBlockedWindow({
			usage: {
				rolling: { status: 'exceeded', percent: Number.NaN, resetsAt: '2026-08-24T07:26:43.000Z' },
				monthly: { status: 'ok', percent: 40, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(blocked).toBeNull();
	});

	it('treats an "ok" status as ok regardless of letter case', () => {
		const blocked = findBlockedWindow({
			usage: {
				rolling: { status: 'OK', percent: 10, resetsAt: '2026-08-24T07:26:43.000Z' },
				monthly: { status: 'Ok', percent: 40, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		});

		expect(blocked).toBeNull();
	});
});
