import { describe, expect, it } from 'vitest';
import {
	filterAntigravityModelsInGroup,
	getAntigravityGroupName,
	groupAntigravityModelsByQuota,
	parseAntigravityQuotaForGroup,
	resolveAntigravityAutoGroupFamily,
	type AuthorizedQuotaResponse,
} from '../../src/providers/antigravity-parse';

const sampleResponse: AuthorizedQuotaResponse = {
	agentModelSorts: [
		{
			groups: [
				{ modelIds: ['gemini-2.5-flash', 'claude-3-7-sonnet'] },
			],
		},
	],
	models: {
		'gemini-2.5-flash': {
			model: 'gemini-2.5-flash',
			displayName: 'Gemini 2.5 Flash',
			quotaInfo: { remainingFraction: 0.6, resetTime: '2026-03-10T12:00:00Z' },
		},
		'claude-3-7-sonnet': {
			model: 'claude-3-7-sonnet',
			displayName: 'Claude 3.7 Sonnet',
			quotaInfo: { remainingFraction: 0.3, resetTime: '2026-03-10T10:00:00Z' },
		},
		'tab_hidden': {
			model: 'tab_hidden',
			displayName: 'Hidden',
			quotaInfo: { remainingFraction: 0.1, resetTime: '2026-03-10T09:00:00Z' },
		},
	},
};

describe('antigravity parse helpers', () => {
	it('resolves families and group names', () => {
		expect(resolveAntigravityAutoGroupFamily('gemini-2.5-flash', 'Gemini 2.5 Flash')).toBe('gemini_flash');
		expect(resolveAntigravityAutoGroupFamily('claude-3-7-sonnet', 'Claude 3.7 Sonnet')).toBe('claude');
		expect(getAntigravityGroupName('gemini_flash')).toBe('Gemini Flash');
	});

	it('groups and filters models by quota pool', () => {
		const groups = groupAntigravityModelsByQuota(sampleResponse);

		expect([...groups.keys()].sort()).toEqual(['Claude', 'Gemini Flash']);
		expect(filterAntigravityModelsInGroup(sampleResponse, 'Gemini Flash').map(model => model.displayName)).toEqual([
			'Gemini 2.5 Flash',
		]);
	});

	it('parses grouped quota usage with 20 percent segments', () => {
		const usage = parseAntigravityQuotaForGroup(
			'Antigravity Gemini Flash',
			[
				{
					displayName: 'Gemini 2.5 Flash',
					quotaInfo: { remainingFraction: 0.6, resetTime: '2026-03-10T12:00:00Z' },
				},
				{
					displayName: 'Gemini 3 Flash Preview',
					quotaInfo: { remainingFraction: 0.2, resetTime: '2026-03-10T14:00:00Z' },
				},
			],
			new Date('2026-03-10T08:00:00Z')
		);

		expect(usage.totalUsed).toBe(80);
		expect(usage.progressSegments).toBe(5);
		expect(usage.resetTime?.toISOString()).toBe('2026-03-10T12:00:00.000Z');
		expect(usage.models?.map(model => model.modelName)).toEqual([
			'Gemini 2.5 Flash',
			'Gemini 3 Flash Preview',
		]);
	});
});
