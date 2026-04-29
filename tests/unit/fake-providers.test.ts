import { describe, expect, it, beforeEach } from 'vitest';
import { TestProviderHarness } from '../../src/testing/fake-providers';
import { UsageProvider } from '../../src/providers/base';
import { ServiceId } from '../../src/types';

describe('TestProviderHarness', () => {
	let harness: TestProviderHarness;

	beforeEach(() => {
		harness = new TestProviderHarness();
	});

	describe('provider creation', () => {
		const expectedServiceIds: ServiceId[] = ['antigravity', 'claudeCode', 'codex', 'cursor', 'kiro', 'gemini'];

		it('creates providers for all expected service IDs', () => {
			const registeredIds: ServiceId[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					registeredIds.push(provider.serviceId);
				},
			};
			harness.registerProviders(mockManager as any);
			expect(registeredIds.sort()).toEqual([...expectedServiceIds].sort());
		});

		it('creates exactly 6 providers', () => {
			const providers: UsageProvider[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					providers.push(provider);
				},
			};
			harness.registerProviders(mockManager as any);
			expect(providers).toHaveLength(6);
		});
	});

	describe('getScenarioIndex', () => {
		it('returns 0 initially', () => {
			expect(harness.getScenarioIndex()).toBe(0);
		});

		it('returns 1 after advanceScenario is called', () => {
			harness.advanceScenario();
			expect(harness.getScenarioIndex()).toBe(1);
		});
	});

	describe('advanceScenario', () => {
		it('increments scenario index from 0 to 1', () => {
			harness.advanceScenario();
			expect(harness.getScenarioIndex()).toBe(1);
		});

		it('clamps scenario index to 1 (does not exceed 1)', () => {
			harness.advanceScenario();
			harness.advanceScenario();
			harness.advanceScenario();
			expect(harness.getScenarioIndex()).toBe(1);
		});
	});

	describe('registerProviders', () => {
		it('registers all fake providers with a UsageManager', async () => {
			const registered: UsageProvider[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					registered.push(provider);
				},
			};

			await harness.registerProviders(mockManager as any);

			expect(registered).toHaveLength(6);
			const serviceIds = registered.map((p) => p.serviceId);
			expect(serviceIds).toContain('antigravity');
			expect(serviceIds).toContain('claudeCode');
			expect(serviceIds).toContain('codex');
			expect(serviceIds).toContain('cursor');
			expect(serviceIds).toContain('kiro');
			expect(serviceIds).toContain('gemini');
		});
	});

	describe('getUsage', () => {
		it('returns scenario 0 data by default', async () => {
			const providers: UsageProvider[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					providers.push(provider);
				},
			};
			await harness.registerProviders(mockManager as any);

			const antigravity = providers.find((p) => p.serviceId === 'antigravity')!;
			const usage = await antigravity.getUsage();

			expect(usage).not.toBeNull();
			expect(usage!.serviceId).toBe('antigravity');
			expect(usage!.totalUsed).toBe(40);
			expect(usage!.totalLimit).toBe(100);
		});

		it('returns scenario 1 data after advanceScenario', async () => {
			const providers: UsageProvider[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					providers.push(provider);
				},
			};
			await harness.registerProviders(mockManager as any);

			harness.advanceScenario();

			const antigravity = providers.find((p) => p.serviceId === 'antigravity')!;
			const usage = await antigravity.getUsage();

			expect(usage).not.toBeNull();
			expect(usage!.serviceId).toBe('antigravity');
			expect(usage!.totalUsed).toBe(60);
			expect(usage!.totalLimit).toBe(100);
		});

		it('returns correct scenario 0 data for claudeCode', async () => {
			const providers: UsageProvider[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					providers.push(provider);
				},
			};
			await harness.registerProviders(mockManager as any);

			const claude = providers.find((p) => p.serviceId === 'claudeCode')!;
			const usage = await claude.getUsage();

			expect(usage).not.toBeNull();
			expect(usage!.totalUsed).toBe(42);
			expect(usage!.totalLimit).toBe(100);
		});

		it('returns correct scenario 1 data for claudeCode', async () => {
			const providers: UsageProvider[] = [];
			const mockManager = {
				registerProvider(provider: UsageProvider) {
					providers.push(provider);
				},
			};
			await harness.registerProviders(mockManager as any);

			harness.advanceScenario();

			const claude = providers.find((p) => p.serviceId === 'claudeCode')!;
			const usage = await claude.getUsage();

			expect(usage).not.toBeNull();
			expect(usage!.totalUsed).toBe(67);
			expect(usage!.totalLimit).toBe(100);
		});
	});
});
