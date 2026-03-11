import * as vscode from 'vscode';
import { ConfigManager } from './managers/config-manager';
import { UsageManager } from './managers/usage-manager';
import { StatusBarController } from './ui/status-bar';
import { SidebarProvider } from './ui/sidebar';
import { DashboardPanel, DashboardSerializer } from './ui/dashboard';
import { registerUsageProviders } from './provider-registration';
import { serializeUsageData } from './dashboard-serialization';
import { debugLog, setDebugLoggingEnabled } from './logger';

let usageManager: UsageManager | undefined;
const TEST_MODE_ENV = 'MANA_BAR_TEST_MODE';

export async function activate(context: vscode.ExtensionContext) {
	const configManager = new ConfigManager();
	setDebugLoggingEnabled(configManager.getDebugLogs());
	debugLog('mana.bar is now active');

	const isTestMode = process.env[TEST_MODE_ENV] === '1';

	// Initialize managers
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
			usageData: (usageManager?.getAllUsageData() ?? []).map((data) =>
				serializeUsageData(data, configManager.getDisplayMode())
			),
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
			setDebugLoggingEnabled(configManager.getDebugLogs());
			// Restart polling when config changes
			usageManager?.stopPolling();
			usageManager?.startPolling();
		})
	);

	debugLog('mana.bar initialized successfully');
}

export function deactivate() {
	usageManager?.dispose();
	usageManager = undefined;
}
