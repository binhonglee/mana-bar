import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageManager, getServiceConfigKey } from '../../src/managers/usage-manager';
import { UsageProvider } from '../../src/providers/base';
import { UsageData } from '../../src/types';

class FakeProvider extends UsageProvider {
	constructor(
		private readonly serviceName: string,
		private readonly usageData: UsageData,
		private readonly available = true,
		private readonly usageSpy?: () => void
	) {
		super();
	}

	getServiceName(): string {
		return this.serviceName;
	}

	async isAvailable(): Promise<boolean> {
		return this.available;
	}

	async getUsage(): Promise<UsageData | null> {
		this.usageSpy?.();
		return this.usageData;
	}

	async getModels(): Promise<string[]> {
		return [];
	}
}

function createConfigManager(overrides?: Partial<Record<'claudeCode' | 'codex' | 'antigravity' | 'gemini', boolean>>) {
	return {
		getServicesConfig: () => ({
			claudeCode: { enabled: overrides?.claudeCode ?? true },
			codex: { enabled: overrides?.codex ?? true },
			antigravity: { enabled: overrides?.antigravity ?? true },
			gemini: { enabled: overrides?.gemini ?? true },
		}),
		getPollingInterval: () => 60,
	} as any;
}

function usageData(serviceName: string, used: number, modelNames?: string[]): UsageData {
	return {
		serviceName,
		totalUsed: used,
		totalLimit: 100,
		resetTime: new Date('2026-03-10T12:00:00.000Z'),
		models: modelNames?.map(modelName => ({
			modelName,
			used,
			limit: 100,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
		})),
		lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
	};
}

describe('getServiceConfigKey', () => {
	it('maps grouped service names onto config keys', () => {
		expect(getServiceConfigKey('Claude Code')).toBe('claudeCode');
		expect(getServiceConfigKey('Codex')).toBe('codex');
		expect(getServiceConfigKey('Antigravity Gemini Flash')).toBe('antigravity');
		expect(getServiceConfigKey('AG Gemini Flash')).toBe('antigravity');
		expect(getServiceConfigKey('Gemini CLI 2.5 Pro')).toBe('gemini');
	});
});

describe('UsageManager', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sorts usage alphabetically and sorts model rows', async () => {
		const manager = new UsageManager(createConfigManager());
		manager.registerProvider(new FakeProvider('Gemini CLI 2.5 Pro', usageData('Gemini CLI 2.5 Pro', 10)));
		manager.registerProvider(new FakeProvider(
			'Antigravity Gemini Flash',
			usageData('Antigravity Gemini Flash', 40, ['Zulu', 'Alpha'])
		));
		manager.registerProvider(new FakeProvider('Codex', usageData('Codex', 30)));

		await manager.refreshAll();

		expect(manager.getRegisteredServiceNames()).toEqual([
			'Antigravity Gemini Flash',
			'Codex',
			'Gemini CLI 2.5 Pro',
		]);
		expect(manager.getAllUsageData().map(item => item.serviceName)).toEqual([
			'Antigravity Gemini Flash',
			'Codex',
			'Gemini CLI 2.5 Pro',
		]);
		expect(manager.getUsageData('Antigravity Gemini Flash')?.models?.map(model => model.modelName)).toEqual([
			'Alpha',
			'Zulu',
		]);
	});

	it('only refreshes enabled and available providers based on config mapping', async () => {
		const geminiSpy = vi.fn();
		const antigravitySpy = vi.fn();
		const manager = new UsageManager(createConfigManager({
			claudeCode: false,
			codex: true,
			antigravity: true,
			gemini: false,
		}));

		manager.registerProvider(new FakeProvider('Claude Code', usageData('Claude Code', 20), true, vi.fn()));
		manager.registerProvider(new FakeProvider('Codex', usageData('Codex', 30), false, vi.fn()));
		manager.registerProvider(new FakeProvider(
			'Antigravity Gemini Flash',
			usageData('Antigravity Gemini Flash', 40),
			true,
			antigravitySpy
		));
		manager.registerProvider(new FakeProvider(
			'Gemini CLI 2.5 Pro',
			usageData('Gemini CLI 2.5 Pro', 10),
			true,
			geminiSpy
		));

		await manager.refreshAll();

		expect(antigravitySpy).toHaveBeenCalledTimes(1);
		expect(geminiSpy).not.toHaveBeenCalled();
		expect(manager.getAllUsageData().map(item => item.serviceName)).toEqual(['Antigravity Gemini Flash']);
	});
});
