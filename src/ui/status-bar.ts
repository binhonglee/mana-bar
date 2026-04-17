import * as vscode from 'vscode';
import { UsageManager } from '../managers/usage-manager';
import { ConfigManager } from '../managers/config-manager';
import { ServiceHealthKind, ServiceSnapshot, StatusBarTooltipLayout } from '../types';
import { getShortServiceLabel } from '../services';
import { buildUsageBlock, toServiceViewModel } from '../usage-display';
import { OutageClient } from '../outage/outage-client';

function healthKindLabel(kind: ServiceHealthKind): string {
	switch (kind) {
		case 'reauthRequired': return 'Reauth needed';
		case 'rateLimited': return 'Rate limited';
		case 'unavailable': return 'Unavailable';
		default: return 'Unknown';
	}
}

function healthKindEmoji(kind: ServiceHealthKind): string {
	switch (kind) {
		case 'reauthRequired': return '🔑';
		case 'rateLimited': return '⏳';
		case 'unavailable': return '⚠️';
		default: return '⚠️';
	}
}

/**
 * Manages the status bar item for displaying usage summary
 */
export class StatusBarController {
	private statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private usageManager: UsageManager,
		private configManager?: ConfigManager,
		private outageClient?: OutageClient
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100
		);
		this.statusBarItem.command = 'manaBar.openSettings';
		this.statusBarItem.show();

		// Subscribe to usage updates
		this.usageManager.onDidUpdateUsage(() => this.update());
		if (this.configManager) {
			this.disposables.push(this.configManager.onConfigChange(() => this.update()));
		}
		if (this.outageClient) {
			this.outageClient.getOutageStatus().then(() => this.update());
		}

		// Initial update
		this.update();
	}

	/**
	 * Update the status bar display
	 */
	private update(): void {
		const displayMode = this.configManager?.getDisplayMode() ?? 'remaining';
		const hidden = this.configManager?.getHiddenServices() ?? [];
		const snapshots = this.usageManager.getServiceSnapshots()
			.filter(s => !hidden.includes(s.serviceName));

		if (snapshots.length === 0) {
			this.statusBarItem.text = 'mana.bar: No data';
			this.statusBarItem.backgroundColor = undefined;
			this.statusBarItem.tooltip = 'No services configured or available';
			return;
		}

		// Build compact summary with per-service status emoji
		const parts: string[] = [];

		for (const snapshot of snapshots) {
			const usage = snapshot.usage;
			if (usage) {
				const viewModel = toServiceViewModel(usage, displayMode);
				// Skip if no limit (means we haven't fetched quota data yet)
				if (usage.totalLimit === 0) {
					parts.push(`${viewModel.shortLabel}: --/--`);
					continue;
				}
				parts.push(`${viewModel.statusEmoji} ${viewModel.shortLabel}: ${viewModel.summaryText}`);
			} else if (snapshot.health) {
				const shortLabel = getShortServiceLabel(snapshot.serviceId, snapshot.serviceName);
				parts.push(`${healthKindEmoji(snapshot.health.kind)} ${shortLabel}: ${healthKindLabel(snapshot.health.kind)}`);
			}
		}

		// Check for outages across all tracked services
		const outages = this.outageClient?.getCachedData()?.reports;
		let outageCount = 0;
		if (outages && snapshots.length > 0) {
			const trackedServiceNames = new Set(snapshots.map(s => s.serviceName.toLowerCase()));
			outageCount = outages.filter(o => trackedServiceNames.has(o.service.toLowerCase())).length;
		}

		const baseText = parts.join(' • ');
		this.statusBarItem.text = outageCount > 0
			? `⚠️ ${outageCount} outage${outageCount === 1 ? '' : 's'} | ${baseText}`
			: baseText;

		this.statusBarItem.backgroundColor = outageCount > 0
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;

		const tooltipLayout = this.configManager?.getStatusBarTooltipLayout() ?? 'regular';
		this.statusBarItem.tooltip = new vscode.MarkdownString(
			this.buildTooltip(snapshots, displayMode, tooltipLayout) + '\n\n_Click to open dashboard_'
		);
	}

	private buildTooltip(
		snapshots: ServiceSnapshot[],
		displayMode: 'used' | 'remaining',
		layout: StatusBarTooltipLayout
	): string {
		if (layout === 'monospaced') {
			return this.buildTooltipMonospaced(snapshots, displayMode);
		}

		return this.buildTooltipRegular(snapshots, displayMode);
	}

	private buildTooltipRegular(snapshots: ServiceSnapshot[], displayMode: 'used' | 'remaining'): string {
		const tooltipRows = snapshots.map(snapshot => {
			const usage = snapshot.usage;
			if (usage) {
				const viewModel = toServiceViewModel(usage, displayMode);
				const resetStr = viewModel.resetText ? `↻ ${viewModel.resetText}` : '—';
				return `| ${viewModel.statusEmoji} ${snapshot.serviceName} | ${viewModel.displayText} | ${resetStr} |`;
			}
			const health = snapshot.health;
			const emoji = health ? healthKindEmoji(health.kind) : '⚠️';
			const display = health ? healthKindLabel(health.kind) : 'Unavailable';
			return `| ${emoji} ${snapshot.serviceName} | ${display} | — |`;
		});

		return `| Service | Usage | Reset |\n|:--|:--|--:|\n${tooltipRows.join('\n')}`;
	}

	private buildTooltipMonospaced(snapshots: ServiceSnapshot[], displayMode: 'used' | 'remaining'): string {
		const rows = snapshots.map(snapshot => {
			const usage = snapshot.usage;
			if (usage) {
				const viewModel = toServiceViewModel(usage, displayMode);
				return {
					state: viewModel.statusEmoji,
					service: snapshot.serviceName,
					display: buildUsageBlock(viewModel.displayPercent),
					reset: viewModel.resetText ? `↻ ${viewModel.resetText}` : '—',
				};
			}
			const health = snapshot.health;
			return {
				state: health ? healthKindEmoji(health.kind) : '⚠️',
				service: snapshot.serviceName,
				display: health ? healthKindLabel(health.kind) : 'Unavailable',
				reset: '—',
			};
		});

		const stateWidth = Math.max('   '.length, ...rows.map(row => row.state.length));
		const serviceWidth = Math.max('Service'.length, ...rows.map(row => row.service.length));
		const usageWidth = Math.max('Usage'.length, ...rows.map(row => row.display.length));
		const resetWidth = Math.max('Reset'.length, ...rows.map(row => row.reset.length));

		const header = [
			'   '.padEnd(stateWidth),
			'Service'.padEnd(serviceWidth),
			'Usage'.padEnd(usageWidth),
			'Reset'.padEnd(resetWidth),
		].join('  ');

		const separator = [
			'-'.repeat(stateWidth),
			'-'.repeat(serviceWidth),
			'-'.repeat(usageWidth),
			'-'.repeat(resetWidth),
		].join('  ');

		const body = rows.map(row => [
			row.state.padEnd(stateWidth),
			row.service.padEnd(serviceWidth),
			row.display.padEnd(usageWidth),
			row.reset.padEnd(resetWidth),
		].join('  '));

		return `\`\`\`text\n${[header, separator, ...body].join('\n')}\n\`\`\``;
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this.statusBarItem.dispose();
	}
}
