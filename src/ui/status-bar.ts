import * as vscode from 'vscode';
import { UsageManager } from '../managers/usage-manager';
import { ConfigManager } from '../managers/config-manager';
import { StatusBarTooltipLayout, UsageData } from '../types';
import { buildUsageBlock, toServiceViewModel } from '../usage-display';

/**
 * Manages the status bar item for displaying usage summary
 */
export class StatusBarController {
	private statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private usageManager: UsageManager, private configManager?: ConfigManager) {
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

		// Initial update
		this.update();
	}

	/**
	 * Update the status bar display
	 */
	private update(): void {
		const displayMode = this.configManager?.getDisplayMode() ?? 'remaining';
		const hidden = this.configManager?.getHiddenServices() ?? [];
		const allUsage = this.usageManager.getAllUsageData()
			.filter(u => !hidden.includes(u.serviceName));

		if (allUsage.length === 0) {
			this.statusBarItem.text = 'mana.bar: No data';
			this.statusBarItem.backgroundColor = undefined;
			this.statusBarItem.tooltip = 'No services configured or available';
			return;
		}

		// Build compact summary with per-service status emoji
		const parts: string[] = [];

		for (const usage of allUsage) {
			const viewModel = toServiceViewModel(usage, displayMode);

			// Skip if no limit (means we haven't fetched quota data yet)
			if (usage.totalLimit === 0) {
				parts.push(`${viewModel.shortLabel}: --/--`);
				continue;
			}
			parts.push(`${viewModel.statusEmoji} ${viewModel.shortLabel}: ${viewModel.summaryText}`);
		}

		this.statusBarItem.text = `${parts.join(' • ')}`;
		this.statusBarItem.backgroundColor = undefined;

		const tooltipLayout = this.configManager?.getStatusBarTooltipLayout() ?? 'regular';
		this.statusBarItem.tooltip = new vscode.MarkdownString(
			this.buildTooltip(allUsage, displayMode, tooltipLayout) + '\n\n_Click to open dashboard_'
		);
	}

	private buildTooltip(
		allUsage: UsageData[],
		displayMode: 'used' | 'remaining',
		layout: StatusBarTooltipLayout
	): string {
		if (layout === 'monospaced') {
			return this.buildTooltipMonospaced(allUsage, displayMode);
		}

		return this.buildTooltipRegular(allUsage, displayMode);
	}

	private buildTooltipRegular(allUsage: UsageData[], displayMode: 'used' | 'remaining'): string {
		const tooltipRows = allUsage.map(usage => {
			const viewModel = toServiceViewModel(usage, displayMode);
			const resetStr = viewModel.resetText ? `↻ ${viewModel.resetText}` : '—';
			return `| ${viewModel.statusEmoji} ${usage.serviceName} | ${viewModel.displayText} | ${resetStr} |`;
		});

		return `| Service | Usage | Reset |\n|:--|:--|--:|\n${tooltipRows.join('\n')}`;
	}

	private buildTooltipMonospaced(allUsage: UsageData[], displayMode: 'used' | 'remaining'): string {
		const rows = allUsage.map(usage => {
			const viewModel = toServiceViewModel(usage, displayMode);
			return {
				state: viewModel.statusEmoji,
				service: viewModel.serviceName,
				display: buildUsageBlock(viewModel.displayPercent),
				reset: viewModel.resetText ? `↻ ${viewModel.resetText}` : '—',
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
