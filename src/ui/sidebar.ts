import * as vscode from 'vscode';
import { UsageManager } from '../managers/usage-manager';
import { ConfigManager } from '../managers/config-manager';
import { UsageStatus } from '../types';
import { toServiceViewModel } from '../usage-display';
import { OutageClient } from '../outage/outage-client';

/**
 * Tree item for the sidebar
 */
class UsageTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		description?: string,
		collapsibleState?: vscode.TreeItemCollapsibleState,
		public readonly iconPath?: vscode.ThemeIcon,
		id?: string
	) {
		super(label, collapsibleState);
		this.description = description;
		this.id = id;
	}
}

/**
 * Provides tree view data for the sidebar
 */
export class SidebarProvider implements vscode.TreeDataProvider<UsageTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<UsageTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private usageManager: UsageManager,
		private configManager?: ConfigManager,
		private outageClient?: OutageClient
	) {
		// Subscribe to usage updates
		this.usageManager.onDidUpdateUsage(() => this.refresh());
		if (this.configManager) {
			this.disposables.push(this.configManager.onConfigChange(() => this.refresh()));
		}
		if (this.outageClient) {
			this.outageClient.getOutageStatus().then(() => this.refresh());
		}
	}

	/**
	 * Refresh the tree view
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Get tree item
	 */
	getTreeItem(element: UsageTreeItem): vscode.TreeItem {
		return element;
	}

	/**
	 * Get children for tree item
	 */
	getChildren(element?: UsageTreeItem): vscode.ProviderResult<UsageTreeItem[]> {
		if (!element) {
			// Root level - show services
			return this.getServices();
		}

		// If element has metadata, it's a service item - show its details
		const serviceName = (element as any).serviceName;
		if (serviceName) {
			return this.getServiceDetails(serviceName);
		}

		return [];
	}

	/**
	 * Get top-level service items
	 */
	private getServices(): UsageTreeItem[] {
		const displayMode = this.configManager?.getDisplayMode() ?? 'remaining';
		const hidden = this.configManager?.getHiddenServices() ?? [];
		const allUsage = this.usageManager.getAllUsageData()
			.filter(u => !hidden.includes(u.serviceName));

		if (allUsage.length === 0) {
			const item = new UsageTreeItem(
				'No services configured',
				undefined,
				vscode.TreeItemCollapsibleState.None,
				new vscode.ThemeIcon('info')
			);
			return [item];
		}

		return allUsage.map(usage => {
			const viewModel = toServiceViewModel(usage, displayMode);
			let icon = viewModel.status === UsageStatus.CRITICAL ? 'error' :
				viewModel.status === UsageStatus.WARNING ? 'warning' : 'pass';
				
			// Check for outages
			if (this.outageClient) {
				const hasOutage = this.outageClient.getCachedData()?.reports.some(
					r => r.service.toLowerCase() === usage.serviceName.toLowerCase()
				);
				if (hasOutage) {
					icon = 'alert';
				}
			}

			const item = new UsageTreeItem(
				viewModel.serviceName,
				viewModel.displayText,
				vscode.TreeItemCollapsibleState.Expanded,
				new vscode.ThemeIcon(icon),
				`service:${viewModel.serviceName}`
			);

			// Store service name for getting children
			(item as any).serviceName = viewModel.serviceName;

			return item;
		});
	}

	/**
	 * Get details for a specific service
	 */
	private getServiceDetails(serviceName: string): UsageTreeItem[] {
		const usage = this.usageManager.getAllUsageData()
			.find(u => u.serviceName === serviceName);

		if (!usage) {
			return [];
		}

		const items: UsageTreeItem[] = [];

		// Reset time item
		if (usage.resetTime) {
			const timeStr = toServiceViewModel(usage, this.configManager?.getDisplayMode() ?? 'remaining').resetText ?? '—';
			items.push(new UsageTreeItem(
				'Resets in',
				timeStr,
				vscode.TreeItemCollapsibleState.None,
				new vscode.ThemeIcon('clock')
			));
		}

		// Per-model breakdown (names only, no percentages since models share quota)
		if (usage.models && usage.models.length > 1) {
			for (const model of usage.models) {
				items.push(new UsageTreeItem(
					model.modelName,
					undefined,
					vscode.TreeItemCollapsibleState.None,
					new vscode.ThemeIcon('symbol-method')
				));
			}
		}

		return items;
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this._onDidChangeTreeData.dispose();
	}
}
