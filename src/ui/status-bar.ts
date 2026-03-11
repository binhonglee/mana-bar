import * as vscode from 'vscode';
import { UsageManager } from '../managers/usage-manager';
import { ConfigManager } from '../managers/config-manager';
import { getUsageStatus, StatusBarTooltipLayout, UsageStatus, UsageData } from '../types';
import { formatTimeUntilReset } from '../utils';
import { formatUsageDisplay, getDisplayPercent } from '../usage-display';

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
		const displayMode = this.configManager?.getDisplayMode() ?? 'used';
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
			// Use service abbreviation
			const abbrev = this.abbreviate(usage.serviceName);

			// Skip if no limit (means we haven't fetched quota data yet)
			if (usage.totalLimit === 0) {
				parts.push(`${abbrev}: --/--`);
				continue;
			}

			const status = getUsageStatus(usage.totalUsed, usage.totalLimit);
			const statusEmoji = status === UsageStatus.CRITICAL ? '🔴' :
				status === UsageStatus.WARNING ? '🟡' : '🟢';

			// If at 100% and has reset time, show reset countdown instead of usage
			if (status === UsageStatus.CRITICAL && usage.resetTime) {
				const timeStr = formatTimeUntilReset(usage.resetTime);
				parts.push(`${statusEmoji} ${abbrev}: ↻${timeStr}`);
			} else {
				parts.push(`${statusEmoji} ${abbrev}: ${formatUsageDisplay(usage.totalUsed, usage.totalLimit, displayMode)}`);
			}
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
			const status = getUsageStatus(usage.totalUsed, usage.totalLimit);
			const statusEmoji = status === UsageStatus.CRITICAL ? '🔴' :
				status === UsageStatus.WARNING ? '🟡' : '🟢';
			const display = formatUsageDisplay(usage.totalUsed, usage.totalLimit, displayMode);
			const resetStr = usage.resetTime
				? `↻ ${formatTimeUntilReset(usage.resetTime)}`
				: '—';
			return `| ${statusEmoji} ${usage.serviceName} | ${display} | ${resetStr} |`;
		});

		return `| Service | Usage | Reset |\n|:--|:--|--:|\n${tooltipRows.join('\n')}`;
	}

	private buildTooltipMonospaced(allUsage: UsageData[], displayMode: 'used' | 'remaining'): string {
		const rows = allUsage.map(usage => ({
			state: this.getStatusEmoji(usage.totalUsed, usage.totalLimit),
			service: usage.serviceName,
			display: this.buildUsageBlock(usage.totalUsed, usage.totalLimit, displayMode),
			reset: usage.resetTime ? `↻ ${formatTimeUntilReset(usage.resetTime)}` : '—',
		}));

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

	private buildUsageBlock(used: number, limit: number, displayMode: 'used' | 'remaining'): string {
		const totalBlocks = 10;
		const filledBlocks = Math.round(getDisplayPercent(used, limit, displayMode) / 10);
		return '█'.repeat(filledBlocks) + '░'.repeat(totalBlocks - filledBlocks);
	}

	private getStatusEmoji(used: number, limit: number): string {
		const status = getUsageStatus(used, limit);
		switch (status) {
			case UsageStatus.CRITICAL:
				return '🔴';
			case UsageStatus.WARNING:
				return '🟡';
			default:
				return '🟢';
		}
	}

	/**
	 * Abbreviate service name for compact display
	 */
	private abbreviate(serviceName: string): string {
		if (serviceName.startsWith('Gemini CLI ')) {
			return this.abbreviateGemini(serviceName);
		}

		switch (serviceName) {
			case 'Claude Code': return 'Claude';
			case 'Codex': return 'Codex';
			case 'Antigravity': return 'Antigravity';
			case 'Antigravity (new)': return 'Antigravity (new)';
			case 'Gemini': return 'Gemini';
			case 'Gemini CLI': return 'Gemini CLI';
			case 'Antigravity Gemini Image': return 'AG Image';
			case 'Antigravity Gemini Pro': return 'AG Pro';
			case 'Antigravity Gemini Flash': return 'AG Flash';
			case 'Antigravity Claude': return 'AG Claude';
			case 'Antigravity Default': return 'AG Default';
			default: return serviceName.substring(0, 6);
		}
	}

	private abbreviateGemini(serviceName: string): string {
		const compactLabel = serviceName
			.replace(/^Gemini CLI\s+/, '')
			.replace(/\bFlash Lite\b/gi, 'Lite')
			.replace(/\bPreview\b/gi, '')
			.replace(/\bVertex\b/gi, '')
			.replace(/\s+/g, ' ')
			.trim();

		return compactLabel ? `GCLI ${compactLabel}` : 'Gemini CLI';
	}


	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this.statusBarItem.dispose();
	}
}
