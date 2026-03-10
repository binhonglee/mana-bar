import * as vscode from 'vscode';
import { ConfigManager } from './managers/config-manager';
import { UsageManager } from './managers/usage-manager';
import { ClaudeCodeProvider } from './providers/claude-code';
import { CodexProvider } from './providers/codex';
import { AntigravityProvider } from './providers/antigravity';
import { GeminiProvider } from './providers/gemini';
import { StatusBarController } from './ui/status-bar';
import { SidebarProvider } from './ui/sidebar';
import { DashboardPanel, DashboardSerializer } from './ui/dashboard';

let usageManager: UsageManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
	console.log('LLM Usage Tracker is now active');

	// Initialize managers
	const configManager = new ConfigManager();
	usageManager = new UsageManager(configManager);

	// Register providers
	const claudeCodeProvider = new ClaudeCodeProvider();
	usageManager.registerProvider(claudeCodeProvider);

	const codexProvider = new CodexProvider(context);
	usageManager.registerProvider(codexProvider);

	// Register Antigravity provider and discover quota groups
	const antigravityProvider = new AntigravityProvider(context);
	try {
		await antigravityProvider.discoverQuotaGroups((provider) => {
			usageManager?.registerProvider(provider);
		});
	} catch (error) {
		console.error('[Antigravity] Discovery failed:', error);
	}

	const geminiProvider = new GeminiProvider();
	try {
		await geminiProvider.discoverQuotaGroups((provider) => {
			usageManager?.registerProvider(provider);
		});
	} catch (error) {
		console.error('[Gemini] Discovery failed:', error);
	}

	// Initialize UI components
	const statusBar = new StatusBarController(usageManager, configManager);
	const sidebarProvider = new SidebarProvider(usageManager, configManager);

	// Register sidebar tree view
	const treeView = vscode.window.createTreeView('llmUsageTrackerSidebar', {
		treeDataProvider: sidebarProvider
	});

	// Register commands
	const refreshCommand = vscode.commands.registerCommand('llmUsageTracker.refresh', async () => {
		vscode.window.showInformationMessage('Refreshing usage data...');
		await usageManager?.refreshAll();
		vscode.window.showInformationMessage('Usage data refreshed');
	});

	const settingsCommand = vscode.commands.registerCommand('llmUsageTracker.openSettings', () => {
		DashboardPanel.createOrShow(context.extensionUri, usageManager!, configManager);
	});

	const dashboardCommand = vscode.commands.registerCommand('llmUsageTracker.openDashboard', () => {
		DashboardPanel.createOrShow(context.extensionUri, usageManager!, configManager);
	});

	// Start polling
	usageManager.startPolling();

	// Add to subscriptions
	// Register webview serializer for panel restoration
	const serializer = vscode.window.registerWebviewPanelSerializer(
		'llmUsageTracker.dashboard',
		new DashboardSerializer(context.extensionUri, usageManager, configManager)
	);

	context.subscriptions.push(
		statusBar,
		sidebarProvider,
		treeView,
		refreshCommand,
		settingsCommand,
		dashboardCommand,
		serializer,
		usageManager,
		configManager.onConfigChange(() => {
			// Restart polling when config changes
			usageManager?.stopPolling();
			usageManager?.startPolling();
		})
	);

	console.log('LLM Usage Tracker initialized successfully');
}

export function deactivate() {
	usageManager?.dispose();
}
