import * as vscode from 'vscode';
import { ConfigManager } from './managers/config-manager';
import { UsageManager } from './managers/usage-manager';
import { StatusBarController } from './ui/status-bar';
import { SidebarProvider } from './ui/sidebar';
import { DashboardPanel, DashboardSerializer } from './ui/dashboard';
import { registerUsageProviders } from './provider-registration';
import { UsageData } from './types';

let usageManager: UsageManager | undefined;
const TEST_MODE_ENV = 'MANA_BAR_TEST_MODE';

function serializeUsageDataForSnapshot(data: UsageData) {
	return {
		serviceName: data.serviceName,
		totalUsed: data.totalUsed,
		totalLimit: data.totalLimit,
		resetTime: data.resetTime?.toISOString(),
		progressSegments: data.progressSegments,
		quotaWindows: data.quotaWindows?.map(window => ({
			label: window.label,
			used: window.used,
			limit: window.limit,
			resetTime: window.resetTime?.toISOString(),
		})),
		models: data.models?.map(model => ({
			modelName: model.modelName,
			used: model.used,
			limit: model.limit,
			resetTime: model.resetTime?.toISOString(),
		})),
		lastUpdated: data.lastUpdated.toISOString(),
	};
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('mana.bar is now active');
	const isTestMode = process.env[TEST_MODE_ENV] === '1';

	// Initialize managers
	const configManager = new ConfigManager();
	usageManager = new UsageManager(configManager);

	const providerRegistration = await registerUsageProviders(usageManager, context, {
		testMode: isTestMode,
	});

	// Initialize UI components
	const statusBar = new StatusBarController(usageManager, configManager);
	const sidebarProvider = new SidebarProvider(usageManager, configManager);

	// Register sidebar tree view
	const treeView = vscode.window.createTreeView('manaBarSidebar', {
		treeDataProvider: sidebarProvider
	});

	// Register commands
	const refreshCommand = vscode.commands.registerCommand('manaBar.refresh', async () => {
		providerRegistration.testHarness?.advanceScenario();
		vscode.window.showInformationMessage('Refreshing usage data...');
		await usageManager?.refreshAll();
		vscode.window.showInformationMessage('Usage data refreshed');
	});

	const settingsCommand = vscode.commands.registerCommand('manaBar.openSettings', () => {
		DashboardPanel.createOrShow(context.extensionUri, usageManager!, configManager);
	});

	const dashboardCommand = vscode.commands.registerCommand('manaBar.openDashboard', () => {
		DashboardPanel.createOrShow(context.extensionUri, usageManager!, configManager);
	});

	const testSnapshotCommand = isTestMode
		? vscode.commands.registerCommand('manaBar.__test.getSnapshot', async () => ({
			providerNames: usageManager?.getRegisteredServiceNames() ?? [],
			usageData: (usageManager?.getAllUsageData() ?? []).map(serializeUsageDataForSnapshot),
			displayMode: configManager.getDisplayMode(),
			dashboard: DashboardPanel.getDebugState(),
			scenarioIndex: providerRegistration.testHarness?.getScenarioIndex() ?? 0,
		}))
		: undefined;

	// Start polling
	usageManager.startPolling();

	// Add to subscriptions
	// Register webview serializer for panel restoration
	const serializer = vscode.window.registerWebviewPanelSerializer(
		'manaBar.dashboard',
		new DashboardSerializer(context.extensionUri, usageManager, configManager)
	);

	context.subscriptions.push(
		statusBar,
		sidebarProvider,
		treeView,
		refreshCommand,
		settingsCommand,
		dashboardCommand,
		...(testSnapshotCommand ? [testSnapshotCommand] : []),
		serializer,
		usageManager,
		configManager.onConfigChange(() => {
			// Restart polling when config changes
			usageManager?.stopPolling();
			usageManager?.startPolling();
		})
	);

	console.log('mana.bar initialized successfully');
}

export function deactivate() {
	usageManager?.dispose();
	usageManager = undefined;
}
