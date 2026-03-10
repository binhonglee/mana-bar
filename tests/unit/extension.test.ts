import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { DashboardPanel } from '../../src/ui/dashboard';

describe('extension activation', () => {
	const originalTestMode = process.env.LLM_USAGE_TRACKER_TEST_MODE;

	beforeEach(() => {
		process.env.LLM_USAGE_TRACKER_TEST_MODE = '1';
		(vscode as any).__testing.reset();
		DashboardPanel.resetForTests();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
	});

	afterEach(() => {
		deactivate();
		DashboardPanel.resetForTests();
		process.env.LLM_USAGE_TRACKER_TEST_MODE = originalTestMode;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('registers commands, refreshes test providers, and reuses the dashboard panel', async () => {
		const context = {
			subscriptions: [] as vscode.Disposable[],
			extensionUri: vscode.Uri.file('/extension-root'),
			globalState: {
				get: () => undefined,
				update: async () => undefined,
			},
		} as unknown as vscode.ExtensionContext;
		const startPollingSpy = vi.spyOn((await import('../../src/managers/usage-manager')).UsageManager.prototype, 'startPolling');
		const stopPollingSpy = vi.spyOn((await import('../../src/managers/usage-manager')).UsageManager.prototype, 'stopPolling');

		await activate(context);
		await vscode.workspace.getConfiguration('llmUsageTracker').update('services', {
			claudeCode: { enabled: true },
			codex: { enabled: true },
			antigravity: { enabled: true },
			gemini: { enabled: true },
		}, vscode.ConfigurationTarget.Global);
		await vscode.commands.executeCommand('llmUsageTracker.refresh');
		await vscode.commands.executeCommand('llmUsageTracker.openDashboard');
		await vscode.commands.executeCommand('llmUsageTracker.openDashboard');
		await vscode.workspace.getConfiguration('llmUsageTracker').update('displayMode', 'remaining', vscode.ConfigurationTarget.Global);

		const snapshot = await vscode.commands.executeCommand<any>('llmUsageTracker.__test.getSnapshot');

		expect((vscode as any).__testing.getRegisteredCommands()).toEqual([
			'llmUsageTracker.refresh',
			'llmUsageTracker.openSettings',
			'llmUsageTracker.openDashboard',
			'llmUsageTracker.__test.getSnapshot',
		]);
		expect(snapshot.providerNames).toEqual([
			'Antigravity Gemini Flash',
			'Claude Code',
			'Codex',
			'Gemini CLI 2.5 Pro',
		]);
		expect(snapshot.usageData).toHaveLength(4);
		expect(snapshot.scenarioIndex).toBe(1);
		expect(snapshot.dashboard).toEqual({
			isOpen: true,
			createCount: 1,
		});
		expect(snapshot.displayMode).toBe('remaining');
		expect((vscode as any).__testing.getCreatedTreeViews()).toHaveLength(1);
		expect((vscode as any).__testing.getRegisteredSerializer('llmUsageTracker.dashboard')).toBeTruthy();
		expect((vscode as any).__testing.getInformationMessages()).toEqual([
			'Refreshing usage data...',
			'Usage data refreshed',
		]);
		expect(startPollingSpy).toHaveBeenCalledTimes(3);
		expect(stopPollingSpy).toHaveBeenCalledTimes(2);
	});
});
