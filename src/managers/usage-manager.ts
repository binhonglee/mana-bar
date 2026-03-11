import * as vscode from 'vscode';
import { UsageProvider } from '../providers/base';
import { UsageData } from '../types';
import { ConfigManager } from './config-manager';

/**
 * Cache entry with expiration
 */
interface CacheEntry {
	data: UsageData;
	expiresAt: number;
}

export function getServiceConfigKey(serviceName: string): 'claudeCode' | 'codex' | 'antigravity' | 'gemini' {
	const normalized = serviceName.toLowerCase().replace(/\s+/g, '');

	if (serviceName.startsWith('AG ') || serviceName.startsWith('Antigravity')) {
		return 'antigravity';
	}
	if (serviceName.startsWith('Gemini')) {
		return 'gemini';
	}

	switch (normalized) {
		case 'claudecode': return 'claudeCode';
		case 'codex': return 'codex';
		case 'antigravity': return 'antigravity';
		case 'gemini': return 'gemini';
		default: return 'claudeCode';
	}
}

/**
 * Manages all usage providers, polling, and caching
 */
export class UsageManager {
	private providers: Map<string, UsageProvider> = new Map();
	private cache: Map<string, CacheEntry> = new Map();
	private pollingTimer: NodeJS.Timeout | null = null;
	private _onDidUpdateUsage = new vscode.EventEmitter<void>();
	private readonly serviceNameCollator = new Intl.Collator(undefined, {
		numeric: true,
		sensitivity: 'base'
	});

	/**
	 * Event fired when usage data is updated
	 */
	public readonly onDidUpdateUsage = this._onDidUpdateUsage.event;

	constructor(
		private configManager: ConfigManager
	) { }

	/**
	 * Register a provider
	 */
	registerProvider(provider: UsageProvider): void {
		const serviceName = provider.getServiceName();
		this.providers.set(serviceName, provider);
	}

	getRegisteredServiceNames(): string[] {
		return [...this.providers.keys()].sort((a, b) => this.serviceNameCollator.compare(a, b));
	}

	/**
	 * Start polling for usage data
	 */
	startPolling(): void {
		// Initial fetch
		this.refreshAll().catch(console.error);

		// Set up polling
		const intervalSeconds = this.configManager.getPollingInterval();
		this.pollingTimer = setInterval(() => {
			this.refreshAll().catch(console.error);
		}, intervalSeconds * 1000);
	}

	/**
	 * Stop polling
	 */
	stopPolling(): void {
		if (this.pollingTimer) {
			clearInterval(this.pollingTimer);
			this.pollingTimer = null;
		}
	}

	/**
	 * Manually refresh all providers
	 */
	async refreshAll(): Promise<void> {
		const servicesConfig = this.configManager.getServicesConfig();
		console.log('[UsageManager] Refreshing all providers, config:', servicesConfig);
		const promises: Promise<void>[] = [];

		for (const [serviceName, provider] of this.providers) {
			// Map service names to config keys
			const configKey = getServiceConfigKey(serviceName);
			const serviceConfig = servicesConfig[configKey];

			console.log(`[UsageManager] Checking ${serviceName}: enabled=${serviceConfig?.enabled}`);

			// Skip if disabled or not configured
			if (!serviceConfig?.enabled) {
				console.log(`[UsageManager] ${serviceName} is disabled, skipping`);
				continue;
			}

			// Check if available
			const isAvailable = await provider.isAvailable();
			console.log(`[UsageManager] ${serviceName} isAvailable: ${isAvailable}`);
			if (!isAvailable) {
				continue;
			}

			// Fetch usage data
			promises.push(
				provider.getUsage().then((data) => {
					console.log(`[UsageManager] ${serviceName} returned data:`, data);
					if (data) {
						this.updateCache(serviceName, data);
					}
				}).catch((error) => {
					console.error(`Error fetching usage for ${serviceName}:`, error);
				})
			);
		}

		await Promise.all(promises);
		console.log('[UsageManager] All providers refreshed, cache:', this.getAllUsageData());
		this._onDidUpdateUsage.fire();
	}

	/**
	 * Get usage data for a specific service (from cache)
	 */
	getUsageData(serviceName: string): UsageData | null {
		const entry = this.cache.get(serviceName);
		if (!entry) {
			return null;
		}

		// Check if expired
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(serviceName);
			return null;
		}

		return entry.data;
	}

	/**
	 * Get all cached usage data
	 */
	getAllUsageData(): UsageData[] {
		const result: UsageData[] = [];
		for (const [serviceName, entry] of this.cache) {
			if (Date.now() <= entry.expiresAt) {
				result.push(entry.data);
			}
		}
		return result.sort((a, b) => this.serviceNameCollator.compare(a.serviceName, b.serviceName));
	}

	/**
	 * Update cache for a service
	 */
	private updateCache(serviceName: string, data: UsageData): void {
		if (data.models && data.models.length > 1) {
			data.models.sort((a, b) => a.modelName.localeCompare(b.modelName));
		}
		const ttlSeconds = this.configManager.getPollingInterval();
		this.cache.set(serviceName, {
			data,
			expiresAt: Date.now() + ttlSeconds * 1000
		});
	}

	/**
	 * Map service name to config key
	 */
	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.stopPolling();
		this._onDidUpdateUsage.dispose();

		// Dispose all providers that have cleanup logic
		for (const provider of this.providers.values()) {
			if (provider.dispose) {
				provider.dispose();
			}
		}
	}
}
