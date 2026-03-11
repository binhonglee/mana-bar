import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toServiceViewModel } from '../../src/usage-display';
import { UsageData, UsageStatus } from '../../src/types';

function createUsageData(overrides?: Partial<UsageData>): UsageData {
	return {
		serviceId: 'gemini',
		serviceName: 'Gemini CLI 2.5 Flash Preview Vertex',
		totalUsed: 18,
		totalLimit: 100,
		resetTime: new Date('2026-03-10T11:00:00.000Z'),
		lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		...overrides,
	};
}

describe('toServiceViewModel', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
	});

	it('formats used and remaining display variants from the same source data', () => {
		const usage = createUsageData();

		expect(toServiceViewModel(usage, 'used')).toMatchObject({
			shortLabel: 'GCLI 2.5 Flash',
			displayText: '18%',
			displayValueText: '18',
			displayUnit: '%',
			displayPercent: 18,
			summaryText: '18%',
		});
		expect(toServiceViewModel(usage, 'remaining')).toMatchObject({
			displayText: '82%',
			displayValueText: '82',
			displayPercent: 82,
			displayVerb: 'left',
		});
	});

	it('switches critical services to countdown summaries when a reset is known', () => {
		const usage = createUsageData({
			serviceId: 'codex',
			serviceName: 'Codex',
			totalUsed: 100,
			totalLimit: 100,
		});

		expect(toServiceViewModel(usage, 'remaining')).toMatchObject({
			status: UsageStatus.CRITICAL,
			summaryText: '↻1h 0m',
			resetText: '1h 0m',
		});
	});

	it('treats zero-limit services as critical while keeping display values bounded', () => {
		const usage = createUsageData({
			serviceId: 'codex',
			serviceName: 'Codex',
			totalUsed: 0,
			totalLimit: 0,
			resetTime: undefined,
		});

		expect(toServiceViewModel(usage, 'used')).toMatchObject({
			status: UsageStatus.CRITICAL,
			displayText: '0/0',
			displayPercent: 0,
			resetText: undefined,
		});
	});
});
