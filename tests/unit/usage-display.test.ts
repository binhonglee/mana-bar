import { describe, expect, it } from 'vitest';
import {
	buildUsageBlock,
	formatUsageDisplay,
	getDisplayModeVerb,
	getDisplayPercent,
	getDisplayValue,
	getRemainingValue,
	getUsedPercent,
	toServiceViewModel,
	toUsageMetricViewModel,
} from '../../src/usage-display';
import { getUsageStatus, UsageData, UsageStatus } from '../../src/types';

describe('usage-display', () => {
	it('formats used and remaining values for percentages and fractions', () => {
		expect(getUsedPercent(25, 100)).toBe(25);
		expect(getUsedPercent(3, 4)).toBe(75);
		expect(getRemainingValue(3, 4)).toBe(1);
		expect(getDisplayValue(40, 100, 'used')).toBe(40);
		expect(getDisplayValue(40, 100, 'remaining')).toBe(60);
		expect(getDisplayPercent(40, 100, 'used')).toBe(40);
		expect(getDisplayPercent(40, 100, 'remaining')).toBe(60);
		expect(formatUsageDisplay(40, 100, 'used')).toBe('40%');
		expect(formatUsageDisplay(40, 100, 'remaining')).toBe('60%');
		expect(formatUsageDisplay(3, 4, 'used')).toBe('3/4');
		expect(formatUsageDisplay(3, 4, 'remaining')).toBe('1/4');
	});

	it('clamps display percentages and exposes display labels', () => {
		expect(getUsedPercent(150, 100)).toBe(100);
		expect(getDisplayPercent(0, 0, 'used')).toBe(0);
		expect(getDisplayModeVerb('used')).toBe('used');
		expect(getDisplayModeVerb('remaining')).toBe('left');
	});
});

describe('getUsageStatus', () => {
	it('classifies usage thresholds', () => {
		expect(getUsageStatus(0, 0)).toBe(UsageStatus.CRITICAL);
		expect(getUsageStatus(79, 100)).toBe(UsageStatus.OK);
		expect(getUsageStatus(80, 100)).toBe(UsageStatus.WARNING);
		expect(getUsageStatus(100, 100)).toBe(UsageStatus.CRITICAL);
	});

	it('handles edge cases at exact boundaries', () => {
		expect(getUsageStatus(0, 100)).toBe(UsageStatus.OK);
		expect(getUsageStatus(79.9, 100)).toBe(UsageStatus.OK);
		expect(getUsageStatus(80.1, 100)).toBe(UsageStatus.WARNING);
		expect(getUsageStatus(99.9, 100)).toBe(UsageStatus.WARNING);
		expect(getUsageStatus(100.1, 100)).toBe(UsageStatus.CRITICAL);
	});

	it('handles over-limit usage', () => {
		expect(getUsageStatus(150, 100)).toBe(UsageStatus.CRITICAL);
		expect(getUsageStatus(200, 100)).toBe(UsageStatus.CRITICAL);
	});
});

describe('buildUsageBlock', () => {
	it('builds empty block for 0%', () => {
		expect(buildUsageBlock(0)).toBe('░░░░░░░░░░');
	});

	it('builds full block for 100%', () => {
		expect(buildUsageBlock(100)).toBe('██████████');
	});

	it('builds half-filled block for 50%', () => {
		expect(buildUsageBlock(50)).toBe('█████░░░░░');
	});

	it('rounds to nearest block for odd percentages', () => {
		expect(buildUsageBlock(15)).toBe('██░░░░░░░░');
		expect(buildUsageBlock(25)).toBe('███░░░░░░░');
		expect(buildUsageBlock(95)).toBe('██████████');
	});

	it('handles custom total blocks', () => {
		expect(buildUsageBlock(50, 4)).toBe('██░░');
		expect(buildUsageBlock(100, 5)).toBe('█████');
		expect(buildUsageBlock(0, 3)).toBe('░░░');
	});

	it('handles values outside 0-100 range', () => {
		expect(buildUsageBlock(-10)).toBe('░░░░░░░░░░');
		expect(buildUsageBlock(150)).toBe('██████████');
	});
});

describe('toUsageMetricViewModel', () => {
	it('creates view model with all fields', () => {
		const resetTime = new Date('2026-03-10T12:00:00.000Z');
		const result = toUsageMetricViewModel(50, 100, resetTime, 'used');

		expect(result.used).toBe(50);
		expect(result.limit).toBe(100);
		expect(result.displayText).toBe('50%');
		expect(result.displayValueText).toBe('50');
		expect(result.displayUnit).toBe('%');
		expect(result.displayPercent).toBe(50);
		expect(result.displayVerb).toBe('used');
		expect(result.status).toBe(UsageStatus.OK);
		expect(result.statusEmoji).toBe('🟢');
		expect(result.resetTime).toBe(resetTime);
		expect(result.resetText).toBeDefined();
	});

	it('handles remaining mode', () => {
		const result = toUsageMetricViewModel(30, 100, undefined, 'remaining');

		expect(result.displayText).toBe('70%');
		expect(result.displayValueText).toBe('70');
		expect(result.displayPercent).toBe(70);
		expect(result.displayVerb).toBe('left');
	});

	it('handles non-percentage limits', () => {
		const result = toUsageMetricViewModel(3, 10, undefined, 'used');

		expect(result.displayText).toBe('3/10');
		expect(result.displayValueText).toBe('3');
		expect(result.displayUnit).toBe('');
	});

	it('handles undefined reset time', () => {
		const result = toUsageMetricViewModel(50, 100, undefined, 'used');

		expect(result.resetTime).toBeUndefined();
		expect(result.resetText).toBeUndefined();
	});

	it('assigns correct status emoji for warning', () => {
		const result = toUsageMetricViewModel(85, 100, undefined, 'used');

		expect(result.status).toBe(UsageStatus.WARNING);
		expect(result.statusEmoji).toBe('🟡');
	});

	it('assigns correct status emoji for critical', () => {
		const result = toUsageMetricViewModel(100, 100, undefined, 'used');

		expect(result.status).toBe(UsageStatus.CRITICAL);
		expect(result.statusEmoji).toBe('🔴');
	});
});

describe('toServiceViewModel', () => {
	function createUsageData(overrides?: Partial<UsageData>): UsageData {
		return {
			serviceId: 'codex',
			serviceName: 'Codex',
			totalUsed: 50,
			totalLimit: 100,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			...overrides,
		};
	}

	it('creates service view model with basic fields', () => {
		const data = createUsageData();
		const result = toServiceViewModel(data, 'used');

		expect(result.serviceId).toBe('codex');
		expect(result.serviceName).toBe('Codex');
		expect(result.shortLabel).toBe('Codex');
		expect(result.lastUpdated).toEqual(data.lastUpdated);
		expect(result.used).toBe(50);
		expect(result.limit).toBe(100);
	});

	it('generates summary text showing usage for OK status', () => {
		const data = createUsageData({ totalUsed: 50, totalLimit: 100 });
		const result = toServiceViewModel(data, 'used');

		expect(result.summaryText).toBe('50%');
	});

	it('generates summary text showing reset time for critical status', () => {
		const data = createUsageData({
			totalUsed: 100,
			totalLimit: 100,
			resetTime: new Date(Date.now() + 3600000), // 1 hour from now
		});
		const result = toServiceViewModel(data, 'used');

		expect(result.summaryText).toMatch(/^↻/);
	});

	it('includes progress segments when provided', () => {
		const data = createUsageData({ progressSegments: 5 });
		const result = toServiceViewModel(data, 'used');

		expect(result.progressSegments).toBe(5);
	});

	it('transforms quota windows', () => {
		const data = createUsageData({
			quotaWindows: [
				{ label: '5-hour', used: 10, limit: 50 },
				{ label: '7-day', used: 100, limit: 500 },
			],
		});
		const result = toServiceViewModel(data, 'used');

		expect(result.quotaWindows).toHaveLength(2);
		expect(result.quotaWindows![0].used).toBe(10);
		expect(result.quotaWindows![0].limit).toBe(50);
		expect(result.quotaWindows![1].used).toBe(100);
		expect(result.quotaWindows![1].limit).toBe(500);
	});

	it('passes through models unchanged', () => {
		const models = [
			{ modelName: 'GPT-4', used: 10, limit: 50 },
			{ modelName: 'GPT-3.5', used: 20, limit: 100 },
		];
		const data = createUsageData({ models });
		const result = toServiceViewModel(data, 'used');

		expect(result.models).toBe(models);
	});

	it('handles different service IDs for short labels', () => {
		const data = createUsageData({
			serviceId: 'vscodeCopilot',
			serviceName: 'VSCode Copilot',
		});
		const result = toServiceViewModel(data, 'used');

		expect(result.shortLabel).toBe('Copilot');
	});
});
