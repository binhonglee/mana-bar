import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageManager } from '../../src/managers/usage-manager';
import { UsageProvider } from '../../src/providers/base';
import { ServiceId, UsageData } from '../../src/types';

class FakeProvider extends UsageProvider {
	readonly serviceId: ServiceId;
	public disposeSpy?: () => void;

	constructor(
		serviceId: ServiceId,
		private readonly serviceName: string,
		private readonly usageData: UsageData,
		private readonly available = true,
		private readonly usageSpy?: () => void,
		private readonly error?: Error
	) {
		super();
		this.serviceId = serviceId;
	}

	getServiceName(): string {
		return this.serviceName;
	}

	async isAvailable(): Promise<boolean> {
		return this.available;
	}

	async getUsage(): Promise<UsageData | null> {
		this.usageSpy?.();
		if (this.error) {
			throw this.error;
		}
		return this.usageData;
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	dispose(): void {
		this.disposeSpy?.();
	}
}

function createConfigManager(
	overrides?: Partial<Record<'claudeCode' | 'codex' | 'vscodeCopilot' | 'antigravity' | 'gemini', boolean>>,
	pollingInterval = 60
) {
	return {
		getServicesConfig: () => ({
			claudeCode: { enabled: overrides?.claudeCode ?? true },
			codex: { enabled: overrides?.codex ?? true },
			vscodeCopilot: { enabled: overrides?.vscodeCopilot ?? true },
			antigravity: { enabled: overrides?.antigravity ?? true },
			gemini: { enabled: overrides?.gemini ?? true },
		}),
		getPollingInterval: () => pollingInterval,
	} as any;
}

function usageData(serviceId: ServiceId, serviceName: string, used: number, modelNames?: string[]): UsageData {
	return {
		serviceId,
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

describe('UsageManager', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => { });
		vi.spyOn(console, 'error').mockImplementation(() => { });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('sorts usage alphabetically and sorts model rows', async () => {
		const manager = new UsageManager(createConfigManager());
		manager.registerProvider(new FakeProvider('gemini', 'Gemini CLI 2.5 Pro', usageData('gemini', 'Gemini CLI 2.5 Pro', 10)));
		manager.registerProvider(new FakeProvider(
			'antigravity',
			'Antigravity Gemini Flash',
			usageData('antigravity', 'Antigravity Gemini Flash', 40, ['Zulu', 'Alpha'])
		));
		manager.registerProvider(new FakeProvider('codex', 'Codex', usageData('codex', 'Codex', 30)));

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

		manager.registerProvider(new FakeProvider('claudeCode', 'Claude Code', usageData('claudeCode', 'Claude Code', 20), true, vi.fn()));
		manager.registerProvider(new FakeProvider('codex', 'Codex', usageData('codex', 'Codex', 30), false, vi.fn()));
		manager.registerProvider(new FakeProvider(
			'antigravity',
			'Antigravity Gemini Flash',
			usageData('antigravity', 'Antigravity Gemini Flash', 40),
			true,
			antigravitySpy
		));
		manager.registerProvider(new FakeProvider(
			'gemini',
			'Gemini CLI 2.5 Pro',
			usageData('gemini', 'Gemini CLI 2.5 Pro', 10),
			true,
			geminiSpy
		));

		await manager.refreshAll();

		expect(antigravitySpy).toHaveBeenCalledTimes(1);
		expect(geminiSpy).not.toHaveBeenCalled();
		expect(manager.getAllUsageData().map(item => item.serviceName)).toEqual(['Antigravity Gemini Flash']);
	});

	it('starts polling immediately, fires update events, and stops cleanly', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
		const usageSpy = vi.fn();
		const updateSpy = vi.fn();
		const manager = new UsageManager(createConfigManager(undefined, 1));
		manager.registerProvider(new FakeProvider('codex', 'Codex', usageData('codex', 'Codex', 30), true, usageSpy));
		manager.onDidUpdateUsage(updateSpy);

		manager.startPolling();
		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(1000);

		expect(usageSpy).toHaveBeenCalledTimes(2);
		expect(updateSpy).toHaveBeenCalledTimes(2);

		manager.stopPolling();
		await vi.advanceTimersByTimeAsync(2000);
		expect(usageSpy).toHaveBeenCalledTimes(2);
	});

	it('evicts expired cache entries based on the polling interval ttl', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
		const manager = new UsageManager(createConfigManager(undefined, 1));
		manager.registerProvider(new FakeProvider('codex', 'Codex', usageData('codex', 'Codex', 30)));

		await manager.refreshAll();
		expect(manager.getUsageData('Codex')?.totalUsed).toBe(30);

		vi.advanceTimersByTime(1_001);
		expect(manager.getUsageData('Codex')).toBeNull();
		expect(manager.getAllUsageData()).toEqual([]);
	});

	it('restartPolling resets the polling interval timer', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
		const usageSpy = vi.fn();
		const manager = new UsageManager(createConfigManager(undefined, 2)); // 2 second interval
		manager.registerProvider(new FakeProvider('codex', 'Codex', usageData('codex', 'Codex', 30), true, usageSpy));

		manager.startPolling();
		await vi.runAllTicks();
		expect(usageSpy).toHaveBeenCalledTimes(1); // Initial fetch

		// Advance 1 second (halfway through interval)
		await vi.advanceTimersByTimeAsync(1000);
		expect(usageSpy).toHaveBeenCalledTimes(1);

		// Restart polling - should trigger immediate refresh and reset timer
		manager.restartPolling();
		await vi.runAllTicks();
		expect(usageSpy).toHaveBeenCalledTimes(2); // Restart triggered refresh

		// Advance 1 second - old timer would have fired, but new timer shouldn't yet
		await vi.advanceTimersByTimeAsync(1000);
		expect(usageSpy).toHaveBeenCalledTimes(2); // No new fetch yet

		// Advance another second - now the new timer should fire
		await vi.advanceTimersByTimeAsync(1000);
		expect(usageSpy).toHaveBeenCalledTimes(3);

		manager.stopPolling();
	});

	it('keeps healthy providers updating when another provider throws and disposes providers', async () => {
		const disposeSpy = vi.fn();
		const manager = new UsageManager(createConfigManager());
		const healthyProvider = new FakeProvider('codex', 'Codex', usageData('codex', 'Codex', 30));
		healthyProvider.disposeSpy = disposeSpy;
		manager.registerProvider(healthyProvider);
		manager.registerProvider(new FakeProvider(
			'claudeCode',
			'Claude Code',
			usageData('claudeCode', 'Claude Code', 20),
			true,
			undefined,
			new Error('boom')
		));

		await manager.refreshAll();

		expect(manager.getAllUsageData().map(item => item.serviceName)).toEqual(['Codex']);

		manager.dispose();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});
