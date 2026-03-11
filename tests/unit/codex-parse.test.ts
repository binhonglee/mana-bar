import { describe, expect, it } from 'vitest';
import {
	formatCodexWindowLabel,
	parseCodexRateLimitsResponse,
} from '../../src/providers/codex-parse';

describe('formatCodexWindowLabel', () => {
	it('formats common window sizes', () => {
		expect(formatCodexWindowLabel(60)).toBe('1 Hour');
		expect(formatCodexWindowLabel(1440)).toBe('1 Day');
		expect(formatCodexWindowLabel(10080)).toBe('1 Week');
		expect(formatCodexWindowLabel(30)).toBe('30 Min');
	});

	it('tolerates off-by-a-few-minutes drift after a reset', () => {
		expect(formatCodexWindowLabel(301)).toBe('5 Hours');
		expect(formatCodexWindowLabel(299)).toBe('5 Hours');
		expect(formatCodexWindowLabel(10081)).toBe('1 Week');
		expect(formatCodexWindowLabel(1441)).toBe('1 Day');
		expect(formatCodexWindowLabel(10074)).toBe('10074 Min');
	});
});

describe('parseCodexRateLimitsResponse', () => {
	it('selects the more exhausted window and emits quota windows', () => {
		const result = parseCodexRateLimitsResponse({
			id: 1,
			result: {
				rateLimits: {
					primary: { usedPercent: 22.1, windowDurationMins: 1440, resetsAt: 1773144000 },
					secondary: { usedPercent: 57.6, windowDurationMins: 10080, resetsAt: 1773662400 },
				},
			},
		}, 'Codex', new Date('2026-03-10T10:00:00Z'));

		expect(result.totalUsed).toBe(58);
		expect(result.quotaWindows?.map(window => window.label)).toEqual(['1 Day', '1 Week']);
		expect(result.lastUpdated.toISOString()).toBe('2026-03-10T10:00:00.000Z');
	});

	it('prefers the longer cooldown if both windows are near the limit', () => {
		const result = parseCodexRateLimitsResponse({
			id: 1,
			result: {
				rateLimits: {
					primary: { usedPercent: 98, windowDurationMins: 1440, resetsAt: 1773144000 },
					secondary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: 1773662400 },
				},
			},
		});

		expect(result.totalUsed).toBe(96);
		expect(result.resetTime?.toISOString()).toBe('2026-03-16T12:00:00.000Z');
	});
});
