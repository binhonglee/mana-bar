import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { SidebarProvider } from '../../src/ui/sidebar';
import { UsageData } from '../../src/types';

function createUsageManager(usageData: UsageData[]) {
	const emitter = new vscode.EventEmitter<void>();
	return {
		onDidUpdateUsage: emitter.event,
		getAllUsageData: () => usageData,
		getServiceSnapshots: () => usageData.map((usage) => ({
			serviceId: usage.serviceId,
			serviceName: usage.serviceName,
			usage,
		})),
	};
}

describe('SidebarProvider', () => {
	beforeEach(() => {
		(vscode as any).__testing.reset();
	});

	it('shows an empty-state item when no services are available', async () => {
		const provider = new SidebarProvider(createUsageManager([]) as any, {
			getDisplayMode: () => 'used',
			getHiddenServices: () => [],
			onConfigChange: () => new vscode.Disposable(),
		} as any);

		const items = await provider.getChildren();

		expect(items).toHaveLength(1);
		expect(items[0]?.label).toBe('No services configured');
	});

	it('filters hidden services from the root list', async () => {
		const provider = new SidebarProvider(createUsageManager([
			{
				serviceId: 'claudeCode',
				serviceName: 'Claude Code',
				totalUsed: 42,
				totalLimit: 100,
				resetTime: new Date('2026-03-10T18:00:00.000Z'),
				lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			},
			{
				serviceId: 'codex',
				serviceName: 'Codex',
				totalUsed: 88,
				totalLimit: 100,
				resetTime: new Date('2026-03-11T18:00:00.000Z'),
				lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			},
		]) as any, {
			getDisplayMode: () => 'remaining',
			getHiddenServices: () => ['Codex'],
			onConfigChange: () => new vscode.Disposable(),
		} as any);

		const items = await provider.getChildren();

		expect(items.map(item => item.label)).toEqual(['Claude Code']);
		expect(items[0]?.description).toBe('58%');
	});

	it('shows reset information and model rows for expanded services', async () => {
		const usageData: UsageData[] = [{
			serviceId: 'antigravity',
			serviceName: 'Antigravity Gemini Flash',
			totalUsed: 40,
			totalLimit: 100,
			resetTime: new Date(Date.now() + (2 * 60 * 60 * 1000)),
			models: [
				{ modelName: 'Gemini 2.5 Flash', used: 40, limit: 100, resetTime: new Date() },
				{ modelName: 'Gemini 3 Flash Preview', used: 20, limit: 100, resetTime: new Date() },
			],
			lastUpdated: new Date(),
		}];
		const provider = new SidebarProvider(createUsageManager(usageData) as any, {
			getDisplayMode: () => 'used',
			getHiddenServices: () => [],
			onConfigChange: () => new vscode.Disposable(),
		} as any);

		const [service] = await provider.getChildren();
		const details = await provider.getChildren(service as any);

		expect(details.map(item => item.label)).toEqual([
			'Resets in',
			'Gemini 2.5 Flash',
			'Gemini 3 Flash Preview',
		]);
	});
});
