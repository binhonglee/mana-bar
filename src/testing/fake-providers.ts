import { UsageProvider } from '../providers/base';
import { UsageData } from '../types';
import { UsageManager } from '../managers/usage-manager';

type UsageFactory = () => UsageData;

class FakeSequenceProvider extends UsageProvider {
	constructor(
		private readonly serviceName: string,
		private readonly usageFactories: UsageFactory[],
		private readonly modelNames: string[],
		private readonly harness: TestProviderHarness
	) {
		super();
	}

	getServiceName(): string {
		return this.serviceName;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<UsageData | null> {
		const index = Math.min(this.harness.getScenarioIndex(), this.usageFactories.length - 1);
		return this.usageFactories[index]();
	}

	async getModels(): Promise<string[]> {
		return [...this.modelNames];
	}
}

function hoursFromNow(hours: number): Date {
	return new Date(Date.now() + (hours * 60 * 60 * 1000));
}

function daysFromNow(days: number): Date {
	return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
}

function buildScenarioProviders(harness: TestProviderHarness): UsageProvider[] {
	return [
		new FakeSequenceProvider(
			'Antigravity Gemini Flash',
			[
				() => ({
					serviceName: 'Antigravity Gemini Flash',
					totalUsed: 40,
					totalLimit: 100,
					resetTime: hoursFromNow(4),
					progressSegments: 5,
					models: [
						{ modelName: 'Gemini 2.5 Flash', used: 40, limit: 100, resetTime: hoursFromNow(4) },
						{ modelName: 'Gemini 3 Flash Preview', used: 20, limit: 100, resetTime: hoursFromNow(3) },
					],
					lastUpdated: new Date(),
				}),
				() => ({
					serviceName: 'Antigravity Gemini Flash',
					totalUsed: 60,
					totalLimit: 100,
					resetTime: hoursFromNow(6),
					progressSegments: 5,
					models: [
						{ modelName: 'Gemini 2.5 Flash', used: 60, limit: 100, resetTime: hoursFromNow(6) },
						{ modelName: 'Gemini 3 Flash Preview', used: 40, limit: 100, resetTime: hoursFromNow(5) },
					],
					lastUpdated: new Date(),
				}),
			],
			['Gemini 2.5 Flash', 'Gemini 3 Flash Preview'],
			harness
		),
		new FakeSequenceProvider(
			'Claude Code',
			[
				() => ({
					serviceName: 'Claude Code',
					totalUsed: 42,
					totalLimit: 100,
					resetTime: daysFromNow(5),
					quotaWindows: [
						{ label: '5 Hour', used: 30, limit: 100, resetTime: hoursFromNow(5) },
						{ label: '7 Day', used: 42, limit: 100, resetTime: daysFromNow(5) },
					],
					models: [],
					lastUpdated: new Date(),
				}),
				() => ({
					serviceName: 'Claude Code',
					totalUsed: 67,
					totalLimit: 100,
					resetTime: daysFromNow(3),
					quotaWindows: [
						{ label: '5 Hour', used: 55, limit: 100, resetTime: hoursFromNow(2) },
						{ label: '7 Day', used: 67, limit: 100, resetTime: daysFromNow(3) },
					],
					models: [],
					lastUpdated: new Date(),
				}),
			],
			[],
			harness
		),
		new FakeSequenceProvider(
			'Codex',
			[
				() => ({
					serviceName: 'Codex',
					totalUsed: 58,
					totalLimit: 100,
					resetTime: daysFromNow(7),
					quotaWindows: [
						{ label: '1 Day', used: 25, limit: 100, resetTime: daysFromNow(1) },
						{ label: '1 Week', used: 58, limit: 100, resetTime: daysFromNow(7) },
					],
					models: [],
					lastUpdated: new Date(),
				}),
				() => ({
					serviceName: 'Codex',
					totalUsed: 76,
					totalLimit: 100,
					resetTime: daysFromNow(6),
					quotaWindows: [
						{ label: '1 Day', used: 48, limit: 100, resetTime: daysFromNow(1) },
						{ label: '1 Week', used: 76, limit: 100, resetTime: daysFromNow(6) },
					],
					models: [],
					lastUpdated: new Date(),
				}),
			],
			[],
			harness
		),
		new FakeSequenceProvider(
			'Gemini CLI 2.5 Pro',
			[
				() => ({
					serviceName: 'Gemini CLI 2.5 Pro',
					totalUsed: 18,
					totalLimit: 100,
					resetTime: hoursFromNow(8),
					models: [
						{ modelName: 'gemini-2.5-pro', used: 18, limit: 100, resetTime: hoursFromNow(8) },
					],
					lastUpdated: new Date(),
				}),
				() => ({
					serviceName: 'Gemini CLI 2.5 Pro',
					totalUsed: 27,
					totalLimit: 100,
					resetTime: hoursFromNow(7),
					models: [
						{ modelName: 'gemini-2.5-pro', used: 27, limit: 100, resetTime: hoursFromNow(7) },
					],
					lastUpdated: new Date(),
				}),
			],
			['gemini-2.5-pro'],
			harness
		),
	];
}

export class TestProviderHarness {
	private scenarioIndex = 0;
	private readonly providers: UsageProvider[];

	constructor() {
		this.providers = buildScenarioProviders(this);
	}

	getScenarioIndex(): number {
		return this.scenarioIndex;
	}

	advanceScenario(): void {
		this.scenarioIndex = Math.min(this.scenarioIndex + 1, 1);
	}

	async registerProviders(usageManager: UsageManager): Promise<void> {
		for (const provider of this.providers) {
			usageManager.registerProvider(provider);
		}
	}
}
