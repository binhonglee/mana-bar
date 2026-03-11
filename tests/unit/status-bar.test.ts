import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function createConfigManager(options?: {
	layout?: 'regular' | 'monospaced';
	displayMode?: 'used' | 'remaining';
	hiddenServices?: string[];
}) {
	return {
		getDisplayMode: () => options?.displayMode ?? 'used' as const,
		getHiddenServices: () => options?.hiddenServices ?? [],
		getStatusBarTooltipLayout: () => options?.layout ?? 'regular',
		onConfigChange: () => new vscode.Disposable(),
	};
}

describe('StatusBarController', () => {
	beforeEach(() => {
		(vscode as any).__testing.reset();
	});

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
			createConfigManager({ layout: 'monospaced' }) as any
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

	it('renders a no-data status bar item when every service is hidden', () => {
		const controller = new StatusBarController(
			createUsageManager(createUsageData()) as any,
			createConfigManager({ hiddenServices: ['Claude Code'] }) as any
		);

		const item = (vscode as any).__testing.getLastStatusBarItem();

		expect(item.text).toBe('mana.bar: No data');
		expect(item.tooltip).toBe('No services configured or available');

		controller.dispose();
	});

	it('shows critical countdowns and Gemini CLI abbreviations in remaining mode', () => {
		const controller = new StatusBarController(
			createUsageManager([
				{
					serviceName: 'Gemini CLI 2.5 Flash Preview Vertex',
					totalUsed: 100,
					totalLimit: 100,
					resetTime: new Date(Date.now() + (60 * 60 * 1000)),
					lastUpdated: new Date(),
				},
			]) as any,
			createConfigManager({ displayMode: 'remaining' }) as any
		);

		const item = (vscode as any).__testing.getLastStatusBarItem();
		const tooltip = (item.tooltip as vscode.MarkdownString).value;

		expect(item.text).toContain('🔴 GCLI 2.5 Flash');
		expect(item.text).toContain('↻');
		expect(tooltip).toContain('Gemini CLI 2.5 Flash Preview Vertex');

		controller.dispose();
	});
});
