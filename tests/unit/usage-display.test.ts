import { describe, expect, it } from 'vitest';
import {
	formatUsageDisplay,
	getDisplayModeVerb,
	getDisplayPercent,
	getDisplayValue,
	getRemainingValue,
	getUsedPercent,
} from '../../src/usage-display';
import { getUsageStatus, UsageStatus } from '../../src/types';

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
});
