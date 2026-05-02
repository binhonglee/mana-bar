import * as vscode from 'vscode';
import { UsageProvider } from '../providers/base';
import { ServiceHealth, ServiceId, ServiceSnapshot, UsageData } from '../types';
import { ConfigManager } from './config-manager';
import { debugLog } from '../logger';

/**
 * Cache entry with expiration
 */
interface CacheEntry {
	data: UsageData;
	expiresAt: number;
}

interface HealthEntry {
	health: ServiceHealth;
	expiresAt: number;
}

export interface RegisteredProvider {
	serviceId: ServiceId;
	serviceName: string;
	provider: UsageProvider;
}

/**
 * Manages all usage providers, polling, and caching
 */
export class UsageManager {
	private providers: Map<string, RegisteredProvider> = new Map();
	private cache: Map<string, CacheEntry> = new Map();
	private healthCache: Map<string, HealthEntry> = new Map();
	private rediscoveryFns: Map<ServiceId, () => Promise<void>> = new Map();
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
		this.providers.set(serviceName, {
			serviceId: provider.serviceId,
			serviceName,
			provider,
		});
	}

	removeProvidersByServiceId(serviceId: ServiceId): void {
		for (const [name, reg] of this.providers) {
			if (reg.serviceId === serviceId) {
				this.providers.delete(name);
				this.cache.delete(name);
				this.healthCache.delete(name);
			}
		}
	}

	registerRediscovery(serviceId: ServiceId, fn: () => Promise<void>): void {
		this.rediscoveryFns.set(serviceId, fn);
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
	 * Restart polling - stops and restarts the timer, triggering an immediate refresh
	 */
	restartPolling(): void {
		this.stopPolling();
		this.startPolling();
	}

	/**
	 * Manually refresh all providers
	 */
	async refreshAll(): Promise<void> {
		const servicesConfig = this.configManager.getServicesConfig();
		debugLog('[UsageManager] Refreshing all providers, config:', servicesConfig);
		const promises: Promise<void>[] = [];

		for (const [serviceName, registeredProvider] of this.providers) {
			const { provider, serviceId } = registeredProvider;
			const serviceConfig = servicesConfig[serviceId];

			debugLog(`[UsageManager] Checking ${serviceName} (${serviceId}): enabled=${serviceConfig?.enabled}`);

			// Skip if disabled or not configured
			if (!serviceConfig?.enabled) {
				debugLog(`[UsageManager] ${serviceName} is disabled, skipping`);
				this.cache.delete(serviceName);
				this.healthCache.delete(serviceName);
				continue;
			}

			// Check if available
			const isAvailable = await provider.isAvailable();
			debugLog(`[UsageManager] ${serviceName} isAvailable: ${isAvailable}`);
			if (!isAvailable) {
				this.cache.delete(serviceName);
				this.healthCache.delete(serviceName);
				continue;
			}

			// Fetch usage data
			promises.push(
				(async () => {
					provider.clearCache();
					return provider.getUsage();
				})().then((data) => {
					debugLog(`[UsageManager] ${serviceName} returned data:`, data);
					if (data) {
						this.updateCache(serviceName, data);
					} else {
						this.cache.delete(serviceName);
					}
					const health = provider.getLastServiceHealth();
					this.updateHealthCache(serviceName, health);
				}).catch((error) => {
					console.error(`Error fetching usage for ${serviceName}:`, error);
					const health = provider.getLastServiceHealth() ?? {
						kind: 'unavailable' as const,
						summary: `${serviceName} encountered an error.`,
						detail: error instanceof Error ? error.message : String(error),
						lastUpdated: new Date(),
					};
					this.updateHealthCache(serviceName, health);
				})
			);
		}

		await Promise.all(promises);

		// Escalate: re-discover any enabled discoverable service that has no usage data
		if (this.rediscoveryFns.size > 0) {
			const serviceIdsWithData = new Set<ServiceId>();
			for (const [name, reg] of this.providers) {
				if (this.cache.has(name)) {
					serviceIdsWithData.add(reg.serviceId);
				}
			}

			for (const [serviceId, rediscover] of this.rediscoveryFns) {
				const serviceConfig = servicesConfig[serviceId];
				if (!serviceConfig?.enabled) {
					continue;
				}
				if (serviceIdsWithData.has(serviceId)) {
					continue;
				}
				debugLog(`[UsageManager] No data for ${serviceId}, attempting re-discovery`);
				try {
					await rediscover();
				} catch (error) {
					debugLog(`[UsageManager] Re-discovery failed for ${serviceId}:`, error);
					continue;
				}
				// Refresh newly registered providers for this service
				for (const [name, reg] of this.providers) {
					if (reg.serviceId !== serviceId || this.cache.has(name)) {
						continue;
					}
					try {
						reg.provider.clearCache();
						const data = await reg.provider.getUsage();
						if (data) {
							this.updateCache(name, data);
						}
						const health = reg.provider.getLastServiceHealth();
						this.updateHealthCache(name, health);
					} catch (error) {
						debugLog(`[UsageManager] Post-rediscovery fetch failed for ${name}:`, error);
					}
				}
			}
		}

		debugLog('[UsageManager] All providers refreshed, cache:', this.getAllUsageData());
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
		const seenAccountKeys = new Set<string>();
		for (const [, entry] of this.cache) {
			if (Date.now() <= entry.expiresAt) {
				const key = entry.data.accountKey;
				if (key) {
					if (seenAccountKeys.has(key)) continue;
					seenAccountKeys.add(key);
					if (entry.data.accountKeyLabel) {
						result.push({ ...entry.data, serviceName: entry.data.accountKeyLabel });
						continue;
					}
				}
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
	 * Store or clear provider-reported health for a service.
	 * Null clears any previous entry (e.g. after a successful refresh).
	 */
	private updateHealthCache(serviceName: string, health: ServiceHealth | null): void {
		if (!health) {
			this.healthCache.delete(serviceName);
			return;
		}
		const ttlSeconds = this.configManager.getPollingInterval();
		this.healthCache.set(serviceName, {
			health,
			expiresAt: Date.now() + ttlSeconds * 1000,
		});
	}

	private getLiveHealth(serviceName: string): ServiceHealth | null {
		const entry = this.healthCache.get(serviceName);
		if (!entry) {
			return null;
		}
		if (Date.now() > entry.expiresAt) {
			this.healthCache.delete(serviceName);
			return null;
		}
		return entry.health;
	}

	/**
	 * Merged view of registered providers, quota usage, and health state.
	 * A snapshot is included when either usage or health data is available.
	 */
	getServiceSnapshots(): ServiceSnapshot[] {
		const snapshots: ServiceSnapshot[] = [];
		const seenAccountKeys = new Set<string>();

		for (const [serviceName, registered] of this.providers) {
			const usageEntry = this.cache.get(serviceName);
			const usage = usageEntry && Date.now() <= usageEntry.expiresAt ? usageEntry.data : undefined;
			const health = this.getLiveHealth(serviceName);

			if (!usage && !health) {
				continue;
			}

			let effectiveName = serviceName;
			if (usage?.accountKey) {
				if (seenAccountKeys.has(usage.accountKey)) {
					continue;
				}
				seenAccountKeys.add(usage.accountKey);
				if (usage.accountKeyLabel) {
					effectiveName = usage.accountKeyLabel;
				}
			}

			snapshots.push({
				serviceId: registered.serviceId,
				serviceName: effectiveName,
				usage: usage
					? (usage.accountKeyLabel && usage.accountKeyLabel !== usage.serviceName
						? { ...usage, serviceName: effectiveName }
						: usage)
					: undefined,
				health: health ?? undefined,
			});
		}

		return snapshots.sort((a, b) => this.serviceNameCollator.compare(a.serviceName, b.serviceName));
	}

	/**
	 * Map service name to config key
	 */
	/**
	 * Clear cache for services that are disabled in config.
	 * Call this immediately on config change to prevent stale data.
	 */
	clearCacheForDisabledServices(): void {
		const servicesConfig = this.configManager.getServicesConfig();
		for (const [serviceName, registeredProvider] of this.providers) {
			const { serviceId } = registeredProvider;
			const serviceConfig = servicesConfig[serviceId];
			if (!serviceConfig?.enabled) {
				debugLog(`[UsageManager] Clearing cache for disabled service: ${serviceName}`);
				this.cache.delete(serviceName);
				this.healthCache.delete(serviceName);
			}
		}
	}

	/**
	 * Manually fire the update event (e.g. after an outage refresh)
	 */
	notifyUpdate(): void {
		this._onDidUpdateUsage.fire();
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.stopPolling();
		this._onDidUpdateUsage.dispose();

		// Dispose all providers that have cleanup logic
		for (const { provider } of this.providers.values()) {
			if (provider.dispose) {
				provider.dispose();
			}
		}
	}
}
