import * as vscode from 'vscode';
import { ServiceConfig, ServicesConfig, StatusBarTooltipLayout, UsageDisplayMode } from '../types';

/**
 * Manages extension configuration
 */
export class ConfigManager {
	private static readonly CONFIG_SECTION = 'manaBar';

	/**
	 * Get the current configuration
	 */
	private getConfig(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(ConfigManager.CONFIG_SECTION);
	}

	/**
	 * Get polling interval in seconds
	 */
	getPollingInterval(): number {
		return this.getConfig().get<number>('pollingInterval', 60);
	}

	getDisplayMode(): UsageDisplayMode {
		return this.getConfig().get<UsageDisplayMode>('displayMode', 'used');
	}

	getStatusBarTooltipLayout(): StatusBarTooltipLayout {
		return this.getConfig().get<StatusBarTooltipLayout>('statusBarTooltipLayout', 'regular');
	}

	/**
	 * Get services configuration
	 */
	getServicesConfig(): ServicesConfig {
		return this.getConfig().get<ServicesConfig>('services', {
			claudeCode: { enabled: false }, // Disabled due to Anthropic API bug
			codex: { enabled: true },
			copilot: { enabled: false },
			antigravity: { enabled: true }, // Auto-detects Antigravity IDE
			gemini: { enabled: false }
		});
	}

	/**
	 * Get configuration for a specific service
	 */
	getServiceConfig(serviceName: keyof ServicesConfig): ServiceConfig | undefined {
		const services = this.getServicesConfig();
		return services[serviceName];
	}

	/**
	 * Update service configuration
	 */
	async updateServiceConfig(serviceName: keyof ServicesConfig, config: ServiceConfig): Promise<void> {
		const services = this.getServicesConfig();
		services[serviceName] = config;
		await this.getConfig().update('services', services, vscode.ConfigurationTarget.Global);
	}

	async updateDisplayMode(mode: UsageDisplayMode): Promise<void> {
		await this.getConfig().update('displayMode', mode, vscode.ConfigurationTarget.Global);
	}

	async updateStatusBarTooltipLayout(layout: StatusBarTooltipLayout): Promise<void> {
		await this.getConfig().update('statusBarTooltipLayout', layout, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Get list of hidden service names
	 */
	getHiddenServices(): string[] {
		return this.getConfig().get<string[]>('hiddenServices', []);
	}

	/**
	 * Toggle a service's hidden state
	 */
	async toggleHideService(serviceName: string): Promise<void> {
		const hidden = this.getHiddenServices();
		const index = hidden.indexOf(serviceName);
		if (index >= 0) {
			hidden.splice(index, 1);
		} else {
			hidden.push(serviceName);
		}
		await this.getConfig().update('hiddenServices', hidden, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Register a callback for when configuration changes
	 */
	onConfigChange(callback: () => void): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(ConfigManager.CONFIG_SECTION)) {
				callback();
			}
		});
	}
}
