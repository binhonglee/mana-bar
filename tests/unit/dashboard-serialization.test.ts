import { describe, expect, it } from 'vitest';
import {
	buildDashboardConfigPayload,
	serializeServiceHealth,
	serializeServiceSnapshot,
	serializeUsageData,
	SerializedUsageData,
} from '../../src/dashboard-serialization';
import { ServiceHealth, ServiceSnapshot, UsageData, UsageStatus } from '../../src/types';

function createMockUsageData(overrides?: Partial<UsageData>): UsageData {
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

describe('serializeUsageData', () => {
	it('serializes basic usage data correctly', () => {
		const data = createMockUsageData();
		const result = serializeUsageData(data, 'used');

		expect(result.serviceId).toBe('codex');
		expect(result.serviceName).toBe('Codex');
		expect(result.totalUsed).toBe(50);
		expect(result.totalLimit).toBe(100);
		expect(result.used).toBe(50);
		expect(result.limit).toBe(100);
		expect(result.displayPercent).toBe(50);
		expect(result.displayVerb).toBe('used');
		expect(result.status).toBe(UsageStatus.OK);
	});

	it('serializes remaining mode correctly', () => {
		const data = createMockUsageData();
		const result = serializeUsageData(data, 'remaining');

		expect(result.displayPercent).toBe(50);
		expect(result.displayVerb).toBe('left');
	});

	it('serializes reset time to ISO string', () => {
		const data = createMockUsageData({
			resetTime: new Date('2026-03-15T18:30:00.000Z'),
		});
		const result = serializeUsageData(data, 'used');

		expect(result.resetTime).toBe('2026-03-15T18:30:00.000Z');
	});

	it('handles undefined reset time', () => {
		const data = createMockUsageData({
			resetTime: undefined,
		});
		const result = serializeUsageData(data, 'used');

		expect(result.resetTime).toBeUndefined();
	});

	it('serializes last updated to ISO string', () => {
		const data = createMockUsageData();
		const result = serializeUsageData(data, 'used');

		expect(result.lastUpdated).toBe('2026-03-10T10:00:00.000Z');
	});

	it('serializes models array', () => {
		const data = createMockUsageData({
			models: [
				{ modelName: 'GPT-4', used: 10, limit: 50, resetTime: new Date('2026-03-10T12:00:00.000Z') },
				{ modelName: 'GPT-3.5', used: 20, limit: 100 },
			],
		});
		const result = serializeUsageData(data, 'used');

		expect(result.models).toHaveLength(2);
		expect(result.models![0]).toEqual({
			modelName: 'GPT-4',
			used: 10,
			limit: 50,
			resetTime: '2026-03-10T12:00:00.000Z',
		});
		expect(result.models![1]).toEqual({
			modelName: 'GPT-3.5',
			used: 20,
			limit: 100,
			resetTime: undefined,
		});
	});

	it('handles undefined models', () => {
		const data = createMockUsageData({
			models: undefined,
		});
		const result = serializeUsageData(data, 'used');

		expect(result.models).toBeUndefined();
	});

	it('serializes quota windows', () => {
		const data = createMockUsageData({
			quotaWindows: [
				{ label: '5-hour', used: 10, limit: 50, resetTime: new Date('2026-03-10T15:00:00.000Z') },
				{ label: '7-day', used: 100, limit: 500 },
			],
		});
		const result = serializeUsageData(data, 'used');

		expect(result.quotaWindows).toHaveLength(2);
		expect(result.quotaWindows![0].label).toBe('5-hour');
		expect(result.quotaWindows![0].used).toBe(10);
		expect(result.quotaWindows![0].limit).toBe(50);
		expect(result.quotaWindows![0].resetTime).toBe('2026-03-10T15:00:00.000Z');
		expect(result.quotaWindows![1].label).toBe('7-day');
		expect(result.quotaWindows![1].resetTime).toBeUndefined();
	});

	it('includes short label based on service', () => {
		const data = createMockUsageData({
			serviceId: 'vscodeCopilot',
			serviceName: 'VSCode Copilot',
		});
		const result = serializeUsageData(data, 'used');

		expect(result.shortLabel).toBe('Copilot');
	});

	it('includes progress segments', () => {
		const data = createMockUsageData({
			progressSegments: 5,
		});
		const result = serializeUsageData(data, 'used');

		expect(result.progressSegments).toBe(5);
	});

	it('calculates correct status for critical usage', () => {
		const data = createMockUsageData({
			totalUsed: 100,
			totalLimit: 100,
		});
		const result = serializeUsageData(data, 'used');

		expect(result.status).toBe(UsageStatus.CRITICAL);
		expect(result.statusEmoji).toBe('🔴');
	});

	it('calculates correct status for warning usage', () => {
		const data = createMockUsageData({
			totalUsed: 85,
			totalLimit: 100,
		});
		const result = serializeUsageData(data, 'used');

		expect(result.status).toBe(UsageStatus.WARNING);
		expect(result.statusEmoji).toBe('🟡');
	});

	it('calculates correct status for OK usage', () => {
		const data = createMockUsageData({
			totalUsed: 50,
			totalLimit: 100,
		});
		const result = serializeUsageData(data, 'used');

		expect(result.status).toBe(UsageStatus.OK);
		expect(result.statusEmoji).toBe('🟢');
	});
});

describe('serializeServiceHealth', () => {
	it('serializes health including ISO timestamp', () => {
		const health: ServiceHealth = {
			kind: 'reauthRequired',
			summary: 'Credentials expired',
			detail: 'Sign in again',
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		};

		const result = serializeServiceHealth(health);

		expect(result).toEqual({
			kind: 'reauthRequired',
			summary: 'Credentials expired',
			detail: 'Sign in again',
			lastUpdated: '2026-03-10T10:00:00.000Z',
		});
	});
});

describe('serializeServiceSnapshot', () => {
	it('serializes usage-only snapshot', () => {
		const snapshot: ServiceSnapshot = {
			serviceId: 'codex',
			serviceName: 'Codex',
			usage: createMockUsageData(),
		};

		const result = serializeServiceSnapshot(snapshot, 'used');
		expect(result.serviceName).toBe('Codex');
		expect(result.usage).toBeDefined();
		expect(result.usage!.totalUsed).toBe(50);
		expect(result.health).toBeUndefined();
	});

	it('serializes health-only snapshot and omits usage metric payload', () => {
		const snapshot: ServiceSnapshot = {
			serviceId: 'kiro',
			serviceName: 'Kiro',
			health: {
				kind: 'reauthRequired',
				summary: 'Kiro credentials expired',
				lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			},
		};

		const result = serializeServiceSnapshot(snapshot, 'used');
		expect(result.serviceName).toBe('Kiro');
		expect(result.usage).toBeUndefined();
		expect(result.health?.kind).toBe('reauthRequired');
		expect(result.health?.summary).toBe('Kiro credentials expired');
	});

	it('serializes combined usage + health snapshot', () => {
		const snapshot: ServiceSnapshot = {
			serviceId: 'codex',
			serviceName: 'Codex',
			usage: createMockUsageData(),
			health: {
				kind: 'rateLimited',
				summary: 'Rate limited',
				lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			},
		};

		const result = serializeServiceSnapshot(snapshot, 'remaining');
		expect(result.usage).toBeDefined();
		expect(result.health?.kind).toBe('rateLimited');
	});
});

describe('buildDashboardConfigPayload', () => {
	it('builds config payload from config manager', () => {
		const mockConfigManager = {
			getDisplayMode: () => 'remaining' as const,
			getStatusBarTooltipLayout: () => 'monospaced' as const,
			getDebugLogs: () => true,
			getPollingInterval: () => 60,
			getServicesConfig: () => ({
				codex: { enabled: true },
				claudeCode: { enabled: false },
			}),
			getHiddenServices: () => ['Codex'],
		};

		const result = buildDashboardConfigPayload(mockConfigManager as any);

		expect(result.displayMode).toBe('remaining');
		expect(result.statusBarTooltipLayout).toBe('monospaced');
		expect(result.debugLogs).toBe(true);
		expect(result.pollingInterval).toBe(60);
		expect(result.services).toEqual({
			codex: { enabled: true },
			claudeCode: { enabled: false },
		});
		expect(result.hiddenServices).toEqual(['Codex']);
		expect(result.serviceDescriptors).toBeDefined();
		expect(result.serviceDescriptors.length).toBeGreaterThan(0);
	});

	it('includes all service descriptors', () => {
		const mockConfigManager = {
			getDisplayMode: () => 'used' as const,
			getStatusBarTooltipLayout: () => 'regular' as const,
			getDebugLogs: () => false,
			getPollingInterval: () => 120,
			getServicesConfig: () => ({}),
			getHiddenServices: () => [],
		};

		const result = buildDashboardConfigPayload(mockConfigManager as any);

		const descriptorIds = result.serviceDescriptors.map((d) => d.id);
		expect(descriptorIds).toContain('codex');
		expect(descriptorIds).toContain('claudeCode');
		expect(descriptorIds).toContain('vscodeCopilot');
		expect(descriptorIds).toContain('antigravity');
		expect(descriptorIds).toContain('gemini');

		result.serviceDescriptors.forEach((d) => {
			expect(d).toHaveProperty('id');
			expect(d).toHaveProperty('name');
			expect(d).toHaveProperty('description');
		});
	});
});
