import * as vscode from 'vscode';
import { UsageData, ModelUsage, QuotaWindowUsage } from '../types';
import { UsageManager } from '../managers/usage-manager';
import { ConfigManager } from '../managers/config-manager';

/**
 * Serialized versions of types with Date -> string conversion for postMessage
 */
interface SerializedModelUsage {
	modelName: string;
	used: number;
	limit: number;
	resetTime?: string;
}

interface SerializedQuotaWindowUsage {
	label: string;
	used: number;
	limit: number;
	resetTime?: string;
}

interface SerializedUsageData {
	serviceName: string;
	totalUsed: number;
	totalLimit: number;
	resetTime?: string;
	progressSegments?: number;
	quotaWindows?: SerializedQuotaWindowUsage[];
	models?: SerializedModelUsage[];
	lastUpdated: string;
}

function serializeUsageData(data: UsageData): SerializedUsageData {
	return {
		serviceName: data.serviceName,
		totalUsed: data.totalUsed,
		totalLimit: data.totalLimit,
		resetTime: data.resetTime?.toISOString(),
		progressSegments: data.progressSegments,
		quotaWindows: data.quotaWindows?.map((window: QuotaWindowUsage) => ({
			label: window.label,
			used: window.used,
			limit: window.limit,
			resetTime: window.resetTime?.toISOString(),
		})),
		models: data.models?.map(m => ({
			modelName: m.modelName,
			used: m.used,
			limit: m.limit,
			resetTime: m.resetTime?.toISOString(),
		})),
		lastUpdated: data.lastUpdated.toISOString(),
	};
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * Manages the webview dashboard panel (singleton)
 */
export class DashboardPanel {
	public static currentPanel: DashboardPanel | undefined;
	private static readonly viewType = 'manaBar.dashboard';
	private static panelCreateCount = 0;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(
		extensionUri: vscode.Uri,
		usageManager: UsageManager,
		configManager: ConfigManager
	): void {
		const column = vscode.window.activeTextEditor?.viewColumn;

		if (DashboardPanel.currentPanel) {
			DashboardPanel.currentPanel._panel.reveal(column);
			DashboardPanel.currentPanel._sendUpdate();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			DashboardPanel.viewType,
			'mana.bar Dashboard',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
			}
		);

		DashboardPanel.panelCreateCount += 1;
		DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, usageManager, configManager);
	}

	public static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		usageManager: UsageManager,
		configManager: ConfigManager
	): void {
		DashboardPanel.panelCreateCount += 1;
		DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, usageManager, configManager);
	}

	public static getDebugState(): { isOpen: boolean; createCount: number } {
		return {
			isOpen: Boolean(DashboardPanel.currentPanel),
			createCount: DashboardPanel.panelCreateCount,
		};
	}

	public static resetForTests(): void {
		DashboardPanel.currentPanel?.dispose();
		DashboardPanel.currentPanel = undefined;
		DashboardPanel.panelCreateCount = 0;
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly _usageManager: UsageManager,
		private readonly _configManager: ConfigManager
	) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			(message) => this._handleMessage(message),
			null,
			this._disposables
		);

		this._disposables.push(
			this._usageManager.onDidUpdateUsage(() => this._sendUsageUpdate())
		);

		this._disposables.push(
			this._configManager.onConfigChange(() => this._sendConfigUpdate())
		);
	}

	private _sendUpdate(): void {
		this._sendUsageUpdate();
		this._sendConfigUpdate();
	}

	private _sendUsageUpdate(): void {
		const allUsage = this._usageManager.getAllUsageData();
		this._panel.webview.postMessage({
			type: 'usageUpdate',
			data: allUsage.map(serializeUsageData),
			timestamp: new Date().toISOString(),
		});
	}

	private _sendConfigUpdate(): void {
		this._panel.webview.postMessage({
			type: 'configUpdate',
			config: {
				displayMode: this._configManager.getDisplayMode(),
				statusBarTooltipLayout: this._configManager.getStatusBarTooltipLayout(),
				pollingInterval: this._configManager.getPollingInterval(),
				services: this._configManager.getServicesConfig(),
				hiddenServices: this._configManager.getHiddenServices(),
			},
		});
	}

	private _handleMessage(message: any): void {
		switch (message.type) {
			case 'ready':
				this._sendUpdate();
				break;
			case 'refresh':
				this._usageManager.refreshAll().catch(console.error);
				break;
			case 'toggleService':
				this._configManager.updateServiceConfig(message.service, {
					enabled: message.enabled,
				});
				break;
			case 'setPollingInterval':
				vscode.workspace.getConfiguration('manaBar').update(
					'pollingInterval',
					message.interval,
					vscode.ConfigurationTarget.Global
				);
				break;
			case 'setDisplayMode':
				this._configManager.updateDisplayMode(message.mode);
				break;
			case 'setStatusBarTooltipLayout':
				this._configManager.updateStatusBarTooltipLayout(message.layout);
				break;
			case 'toggleHideService':
				this._configManager.toggleHideService(message.service);
				break;
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'dashboard.css')
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'dashboard.js')
		);
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${cssUri}">
	<title>mana.bar Dashboard</title>
</head>
<body>
	<header class="header">
		<div class="header-left">
			<h1 class="header-title">mana.bar</h1>
		</div>
		<nav class="tab-bar">
			<button class="tab active" data-tab="dashboard">Dashboard</button>
			<button class="tab" data-tab="settings">Settings</button>
		</nav>
		<div class="header-right">
			<button id="refresh-btn" class="header-btn" title="Refresh now">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
					<path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.236.528 1.949 0 2.044-1.58 3.713-3.574 3.86l.203-.203.071-.087-.008-.112-.088-.071-.112.008-1 1-.071.087.008.112.087.071 1 1 .112.008.087-.071.071-.087-.008-.112-.071-.087-.169-.169c2.345-.176 4.186-2.133 4.186-4.512 0-.956-.292-1.843-.793-2.576l.254-.193zM7.744 3.525l-.203.203-.071.087.008.112.088.071.112-.008 1-1 .071-.087-.008-.112L8.654 2.72l-1-1-.112-.008-.087.071-.071.087.008.112.071.087.169.169C5.326 2.414 3.486 4.37 3.486 6.75c0 .956.292 1.843.793 2.576l-.254.193.579.939 1.068-.812.076-.094A3.893 3.893 0 015.22 7.603c0-2.044 1.58-3.713 3.574-3.86l-.203.203-.071.087.008.112.088.071.112-.008 1-1 .071-.087-.008-.112-.087-.071-1-1-.112-.008-.087.071-.071.087.008.112.071.087.169.169z"/>
				</svg>
			</button>
		</div>
	</header>

	<main id="dashboard-tab" class="tab-content active">
		<div class="cards-grid" id="cards-container"></div>
		<div class="hidden-section hidden" id="hidden-section">
			<div class="hidden-section-header">
				<span class="hidden-section-title">Hidden</span>
			</div>
			<div class="cards-grid" id="hidden-cards-container"></div>
		</div>
		<div class="empty-state" id="empty-state">
			<div class="empty-icon">
				<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z"/>
				</svg>
			</div>
			<h2>No Services Active</h2>
			<p>Enable LLM services in the Settings tab to start tracking usage.</p>
			<button id="go-settings-btn" class="btn-primary">Go to Settings</button>
		</div>
	</main>

	<main id="settings-tab" class="tab-content">
		<div class="settings-container">
			<section class="settings-section">
				<h2 class="section-title">Services</h2>
				<p class="section-desc">Enable or disable LLM service tracking.</p>
				<div class="services-grid" id="services-settings"></div>
			</section>
			<section class="settings-section">
				<h2 class="section-title">Display</h2>
				<p class="section-desc">Choose whether quota values show what you have used or what you have left.</p>
				<div class="services-grid">
					<div class="setting-card">
						<div class="setting-row">
							<div class="setting-info">
								<span class="setting-label">Quota display</span>
								<span class="setting-hint">This affects the dashboard, sidebar, and status bar.</span>
							</div>
							<div class="select-group">
								<select id="display-mode-select" class="setting-select">
									<option value="used">Used</option>
									<option value="remaining">Remaining</option>
								</select>
							</div>
						</div>
					</div>
					<div class="setting-card">
						<div class="setting-row">
							<div class="setting-info">
								<span class="setting-label">Status bar hover</span>
								<span class="setting-hint">Choose between the regular layout and the fixed-width monospaced layout.</span>
							</div>
							<div class="select-group">
								<select id="status-bar-tooltip-layout-select" class="setting-select">
									<option value="regular">Regular</option>
									<option value="monospaced">Monospaced</option>
								</select>
							</div>
						</div>
					</div>
				</div>
			</section>
			<section class="settings-section">
				<h2 class="section-title">Polling</h2>
				<p class="section-desc">How often to refresh usage data from services.</p>
				<div class="services-grid">
					<div class="setting-card">
						<div class="setting-row">
							<div class="setting-info">
								<span class="setting-label">Refresh interval</span>
								<span class="setting-hint">Lower values increase responsiveness but may cause more API calls.</span>
							</div>
							<div class="slider-group">
								<input type="range" id="polling-slider" min="10" max="300" step="5" value="60">
								<span id="polling-value" class="slider-value">60s</span>
							</div>
						</div>
					</div>
				</div>
			</section>
		</div>
	</main>

	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	public dispose(): void {
		DashboardPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const d = this._disposables.pop();
			if (d) {
				d.dispose();
			}
		}
	}
}

/**
 * Restores dashboard panel on VSCode restart
 */
export class DashboardSerializer implements vscode.WebviewPanelSerializer {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly usageManager: UsageManager,
		private readonly configManager: ConfigManager
	) { }

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: any): Promise<void> {
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		DashboardPanel.revive(panel, this.extensionUri, this.usageManager, this.configManager);
	}
}
