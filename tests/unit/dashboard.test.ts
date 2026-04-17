import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { DashboardPanel, DashboardSerializer } from '../../src/ui/dashboard';
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
		refreshAll: vi.fn(async () => undefined),
		restartPolling: vi.fn(),
		fireUpdate: () => emitter.fire(),
	};
}

function createConfigManager() {
	const emitter = new vscode.EventEmitter<void>();
	return {
		getDisplayMode: () => 'used' as const,
		getStatusBarTooltipLayout: () => 'regular' as const,
		getDebugLogs: () => false,
		getPollingInterval: () => 60,
		getServicesConfig: () => ({
			claudeCode: { enabled: true },
			codex: { enabled: true },
			vscodeCopilot: { enabled: true },
			antigravity: { enabled: true },
			gemini: { enabled: true },
		}),
		getHiddenServices: () => ['Codex'],
		updateServiceConfig: vi.fn(async () => undefined),
		updateDisplayMode: vi.fn(async () => undefined),
		updateStatusBarTooltipLayout: vi.fn(async () => undefined),
		updateDebugLogs: vi.fn(async () => undefined),
		toggleHideService: vi.fn(async () => undefined),
		onConfigChange: (callback: () => void) => emitter.event(callback),
		fireChange: () => emitter.fire(),
	};
}

function createOutageClient() {
	return {
		getOutageStatus: vi.fn(async () => ({ reports: [], lastFetched: new Date() })),
		refresh: vi.fn(async () => ({ reports: [], lastFetched: new Date() })),
		getCachedData: vi.fn(() => ({ reports: [], lastFetched: new Date() }))
	};
}

function createOutageReporter() {
	return {
		reportOutage: vi.fn(async () => undefined)
	};
}

const USAGE_DATA: UsageData[] = [{
	serviceId: 'codex',
	serviceName: 'Codex',
	totalUsed: 58,
	totalLimit: 100,
	resetTime: new Date('2026-03-11T18:00:00.000Z'),
	quotaWindows: [
		{ label: '1 Day', used: 25, limit: 100, resetTime: new Date('2026-03-11T10:00:00.000Z') },
	],
	lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
}];

describe('DashboardPanel', () => {
	beforeEach(() => {
		(vscode as any).__testing.reset();
		DashboardPanel.resetForTests();
	});

	it('creates a singleton webview panel, generates HTML, and reuses the existing panel', () => {
		const usageManager = createUsageManager(USAGE_DATA);
		const configManager = createConfigManager();
		const outageClient = createOutageClient();
		const outageReporter = createOutageReporter();
		const extensionUri = vscode.Uri.file('/extension-root');

		DashboardPanel.createOrShow(extensionUri, usageManager as any, configManager as any, outageClient as any, outageReporter as any);
		let [panel] = (vscode as any).__testing.getCreatedWebviewPanels();

		expect(panel.webview.html).toContain("style-src vscode-test-csp 'unsafe-inline'");
		expect(panel.webview.html).toContain('webview:/extension-root/media/dashboard.css');
		expect(panel.webview.html).toContain('webview:/extension-root/media/dashboard.js');

		DashboardPanel.createOrShow(extensionUri, usageManager as any, configManager as any, outageClient as any, outageReporter as any);
		[panel] = (vscode as any).__testing.getCreatedWebviewPanels();

		expect((vscode as any).__testing.getCreatedWebviewPanels()).toHaveLength(1);
		expect(panel.revealCalls).toEqual([undefined]);
		expect(panel.webview.postedMessages).toHaveLength(2);
	});

	it('sends updates on ready and routes incoming webview messages', async () => {
		const usageManager = createUsageManager(USAGE_DATA);
		const configManager = createConfigManager();
		const outageClient = createOutageClient();
		const outageReporter = createOutageReporter();

		DashboardPanel.createOrShow(vscode.Uri.file('/extension-root'), usageManager as any, configManager as any, outageClient as any, outageReporter as any);
		const [panel] = (vscode as any).__testing.getCreatedWebviewPanels();

		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'ready' });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'refresh' });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'toggleService', service: 'gemini', enabled: false });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'setPollingInterval', interval: 120 });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'setDisplayMode', mode: 'remaining' });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'setStatusBarTooltipLayout', layout: 'monospaced' });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'setDebugLogs', enabled: true });
		(vscode as any).__testing.dispatchWebviewMessage(panel, { type: 'toggleHideService', service: 'Codex' });

		expect(panel.webview.postedMessages).toEqual([
			expect.objectContaining({ type: 'usageUpdate' }),
			expect.objectContaining({ type: 'configUpdate' }),
		]);
		expect(usageManager.restartPolling).toHaveBeenCalledTimes(1);
		expect(configManager.updateServiceConfig).toHaveBeenCalledWith('gemini', { enabled: false });
		expect((vscode as any).__testing.getConfiguration('manaBar', 'pollingInterval')).toBe(120);
		expect(configManager.updateDisplayMode).toHaveBeenCalledWith('remaining');
		expect(configManager.updateStatusBarTooltipLayout).toHaveBeenCalledWith('monospaced');
		expect(configManager.updateDebugLogs).toHaveBeenCalledWith(true);
		expect(configManager.toggleHideService).toHaveBeenCalledWith('Codex');
	});

	it('revives serialized panels and clears singleton state on dispose', async () => {
		const usageManager = createUsageManager(USAGE_DATA);
		const configManager = createConfigManager();
		const outageClient = createOutageClient();
		const outageReporter = createOutageReporter();
		const serializer = new DashboardSerializer(vscode.Uri.file('/extension-root'), usageManager as any, configManager as any, outageClient as any, outageReporter as any);
		const panel = vscode.window.createWebviewPanel('manaBar.dashboard', 'Dashboard', vscode.ViewColumn.One, {
			enableScripts: true,
		}) as any;

		await serializer.deserializeWebviewPanel(panel, {});

		expect(panel.webview.options).toEqual({
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(vscode.Uri.file('/extension-root'), 'media'),
				vscode.Uri.joinPath(vscode.Uri.file('/extension-root'), 'assets'),
			],
		});
		expect(DashboardPanel.getDebugState()).toEqual({
			isOpen: true,
			createCount: 1,
		});

		panel.dispose();
		expect(DashboardPanel.getDebugState().isOpen).toBe(false);
	});
});
