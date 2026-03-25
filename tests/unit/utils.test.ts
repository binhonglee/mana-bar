import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTimeUntilReset } from '../../src/utils';

describe('formatTimeUntilReset', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('shows days and hours for long reset windows', () => {
		expect(formatTimeUntilReset(new Date('2026-03-12T17:00:00.000Z'))).toBe('2d 5h');
	});

	it('shows hours and minutes for shorter reset windows', () => {
		expect(formatTimeUntilReset(new Date('2026-03-10T15:30:00.000Z'))).toBe('3h 30m');
		expect(formatTimeUntilReset(new Date('2026-03-10T12:45:00.000Z'))).toBe('45m');
	});

	it('shows just now for recently past reset times', () => {
		expect(formatTimeUntilReset(new Date('2026-03-10T11:59:59.000Z'))).toBe('Just now');
		expect(formatTimeUntilReset(new Date('2026-03-10T11:59:01.000Z'))).toBe('Just now');
	});

	it('shows -- for reset times far in the past', () => {
		expect(formatTimeUntilReset(new Date('2026-03-10T11:58:00.000Z'))).toBe('--');
		expect(formatTimeUntilReset(new Date('1970-01-01T00:00:00.000Z'))).toBe('--');
	});
});
