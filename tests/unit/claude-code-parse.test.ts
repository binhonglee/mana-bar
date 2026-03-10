import { describe, expect, it } from 'vitest';
import { parseClaudeUsageResponse } from '../../src/providers/claude-code-parse';

describe('parseClaudeUsageResponse', () => {
	it('selects the more exhausted window and shapes quota windows', () => {
		const result = parseClaudeUsageResponse({
			five_hour: { utilization: 31.2, resets_at: '2026-03-10T12:00:00Z' },
			seven_day: { utilization: 64.8, resets_at: '2026-03-15T12:00:00Z' },
		}, 'Claude Code', new Date('2026-03-10T10:00:00Z'));

		expect(result.totalUsed).toBe(65);
		expect(result.resetTime?.toISOString()).toBe('2026-03-15T12:00:00.000Z');
		expect(result.quotaWindows?.map(window => window.label)).toEqual(['5 Hour', '1 Week']);
		expect(result.lastUpdated.toISOString()).toBe('2026-03-10T10:00:00.000Z');
	});

	it('prefers the longer cooldown when both windows are nearly exhausted', () => {
		const result = parseClaudeUsageResponse({
			five_hour: { utilization: 99, resets_at: '2026-03-10T12:00:00Z' },
			seven_day: { utilization: 97, resets_at: '2026-03-14T12:00:00Z' },
		});

		expect(result.totalUsed).toBe(97);
		expect(result.resetTime?.toISOString()).toBe('2026-03-14T12:00:00.000Z');
	});
});
