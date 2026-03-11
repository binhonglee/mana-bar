import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { StatusBarController } from '../../src/ui/status-bar';
import { UsageData } from '../../src/types';

function createUsageData(): UsageData[] {
	return [
		{
			serviceName: 'Claude Code',
			totalUsed: 42,
			totalLimit: 100,
			resetTime: new Date('2026-03-15T12:00:00.000Z'),
			lastUpdated: new Date('2026-03-10T12:00:00.000Z'),
		},
	];
}

function createUsageManager(usageData: UsageData[]) {
	const emitter = new vscode.EventEmitter<void>();

	return {
		onDidUpdateUsage: emitter.event,
		getAllUsageData: () => usageData,
	};
}

function createConfigManager(layout: 'regular' | 'monospaced') {
	return {
		getDisplayMode: () => 'used' as const,
		getHiddenServices: () => [],
		getStatusBarTooltipLayout: () => layout,
		onConfigChange: () => new vscode.Disposable(),
	};
}

describe('StatusBarController', () => {
	afterEach(() => {
		(vscode as any).__testing.resetStatusBarItem();
	});

	it('renders the classic markdown table layout when configured', () => {
		const controller = new StatusBarController(
			createUsageManager(createUsageData()) as any,
			createConfigManager('regular') as any
		);

		const item = (vscode as any).__testing.getLastStatusBarItem();
		const tooltip = (item.tooltip as vscode.MarkdownString).value;

		expect(tooltip).toContain('| Service | Usage | Reset |');
		expect(tooltip).toContain('| 🟢 Claude Code | 42% |');

		controller.dispose();
	});

	it('renders the fixed-width columns layout when configured', () => {
		const controller = new StatusBarController(
			createUsageManager(createUsageData()) as any,
			createConfigManager('monospaced') as any
		);

		const item = (vscode as any).__testing.getLastStatusBarItem();
		const tooltip = (item.tooltip as vscode.MarkdownString).value;

		expect(tooltip).toContain('```text');
		expect(tooltip).toContain('Service');
		expect(tooltip).toContain('Usage');
		expect(tooltip).toContain('🟢');
		expect(tooltip).toContain('Claude Code');
		expect(tooltip).toContain('████░░░░░░');
		expect(tooltip).not.toContain('42%');

		controller.dispose();
	});
});
