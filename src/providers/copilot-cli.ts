import * as vscode from 'vscode';
import { UsageProvider } from './base';
import { QuotaWindowUsage, UsageData } from '../types';
import { fileExists, readJsonFile, joinPath, getHomeDir } from '../utils';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCacheExpiry, getCachedValue, withStaleFallback } from './cache';
import { debugLog } from '../logger';

const execAsync = promisify(exec);

const SERVICE_NAME = 'Copilot CLI';
const COPILOT_ENTITLEMENT_URL = 'https://api.github.com/copilot_internal/user';
const TOKEN_SECRET_KEY = 'copilotCliToken';

interface CopilotCliConfig {
	logged_in_users?: Array<{
		host?: string;
		login?: string;
	}>;
}

interface CopilotEntitlementResponse {
	quota_snapshots?: Record<string, {
		entitlement?: unknown;
		remaining?: unknown;
		percent_remaining?: unknown;
		overage_permitted?: unknown;
		overage_count?: unknown;
		unlimited?: unknown;
	}>;
	quota_reset_date?: unknown;
	quota_reset_date_utc?: unknown;
	limited_user_reset_date?: unknown;
	monthly_quotas?: {
		chat?: unknown;
		completions?: unknown;
	};
	limited_user_quotas?: {
		chat?: unknown;
		completions?: unknown;
	};
}

interface ParsedQuotaSnapshot {
	quota: number;
	used: number;
	resetDate?: Date;
	quotaWindows?: QuotaWindowUsage[];
	unlimited: boolean;
	observedAt: number;
}

export interface SecretStorageLike {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

export interface CopilotCliProviderDeps {
	now?: () => number;
	platform?: NodeJS.Platform;
	homeDir?: string;
	fileExists?: (filePath: string) => Promise<boolean>;
	readJsonFile?: <T>(filePath: string) => Promise<T | null>;
	exec?: (command: string) => Promise<{ stdout: string; stderr?: string }>;
	fetch?: typeof globalThis.fetch;
	secrets?: SecretStorageLike;
}

export class CopilotCliProvider extends UsageProvider {
	readonly serviceId = 'copilotCli' as const;
	private readonly CACHE_TTL = 180 * 1000; // 3 minutes
	private readonly copilotDir: string;
	private readonly configFile: string;
	private readonly deps: Required<Omit<CopilotCliProviderDeps, 'fetch' | 'secrets'>> & {
		fetch: typeof globalThis.fetch | undefined;
		secrets: SecretStorageLike | undefined;
	};

	private cachedData: UsageData | null = null;
	private cacheExpiry: number = 0;

	// In-memory cache for current session (fallback if secrets unavailable)
	private memoryToken: string | null = null;

	constructor(context: vscode.ExtensionContext, deps: CopilotCliProviderDeps = {}) {
		super();
		this.deps = {
			now: deps.now ?? Date.now,
			platform: deps.platform ?? process.platform,
			homeDir: deps.homeDir ?? getHomeDir(),
			fileExists: deps.fileExists ?? fileExists,
			readJsonFile: deps.readJsonFile ?? readJsonFile,
			exec: deps.exec ?? execAsync,
			fetch: deps.fetch ?? globalThis.fetch,
			secrets: deps.secrets ?? context.secrets,
		};
		this.copilotDir = joinPath(this.deps.homeDir, '.copilot');
		this.configFile = joinPath(this.copilotDir, 'config.json');
	}

	getServiceName(): string {
		return SERVICE_NAME;
	}

	async isAvailable(): Promise<boolean> {
		// Check if ~/.copilot directory exists
		if (!await this.deps.fileExists(this.copilotDir)) {
			return false;
		}

		// Check if config.json exists and has logged_in_users
		// We don't check for token here to avoid triggering keychain prompts
		// The actual token check happens in getUsage()
		const config = await this.deps.readJsonFile<CopilotCliConfig>(this.configFile);
		if (!config?.logged_in_users?.length) {
			return false;
		}

		const user = config.logged_in_users[0];
		return Boolean(user?.host && user?.login);
	}

	async getUsage(): Promise<UsageData | null> {
		const cachedData = getCachedValue(this.cachedData, this.cacheExpiry, this.deps.now());
		if (cachedData) {
			debugLog('[CopilotCli] Returning cached data');
			return cachedData;
		}

		return withStaleFallback(async () => {
			const token = await this.getAuthToken();
			debugLog('[CopilotCli] Got auth token:', token ? `${token.substring(0, 10)}...` : 'null');
			if (!token) {
				debugLog('[CopilotCli] No auth token, returning null');
				return null;
			}

			const usageData = await this.fetchUsageFromAPI(token);
			debugLog('[CopilotCli] Fetched usage data:', usageData);
			if (usageData) {
				this.cachedData = usageData;
				this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
			}

			return usageData;
		}, this.cachedData, (error) => {
			console.error('[CopilotCli] Failed to fetch usage:', error);
		});
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	/**
	 * Get OAuth access token, using VS Code SecretStorage to avoid repeated keychain prompts.
	 *
	 * Flow:
	 * 1. Try VS Code SecretStorage (no system prompts)
	 * 2. If not found, try system keychain (may prompt once on macOS)
	 * 3. If keychain succeeds, store in SecretStorage for future use
	 * 4. Fallback to hosts.json file
	 */
	private async getAuthToken(): Promise<string | null> {
		// Read config to get logged_in_users (needed to verify user is still logged in)
		const config = await this.deps.readJsonFile<CopilotCliConfig>(this.configFile);
		if (!config?.logged_in_users?.length) {
			// User logged out - clear stored token
			await this.clearStoredToken();
			return null;
		}

		const user = config.logged_in_users[0];
		if (!user?.host || !user?.login) {
			return null;
		}

		// 1. Try VS Code SecretStorage first (no system prompts)
		if (this.deps.secrets) {
			try {
				const storedToken = await this.deps.secrets.get(TOKEN_SECRET_KEY);
				if (storedToken) {
					debugLog('[CopilotCli] Using token from SecretStorage');
					return storedToken;
				}
			} catch {
				debugLog('[CopilotCli] SecretStorage read failed');
			}
		}

		// Fallback to in-memory cache if secrets unavailable
		if (this.memoryToken) {
			return this.memoryToken;
		}

		let token: string | null = null;

		// 2. Try macOS keychain (may prompt once)
		if (this.deps.platform === 'darwin') {
			try {
				const keychainAccount = `${user.host}:${user.login}`;
				const { stdout } = await this.deps.exec(
					`security find-generic-password -s "copilot-cli" -a "${keychainAccount}" -w 2>/dev/null`
				);
				token = stdout.trim() || null;
				if (token) {
					debugLog('[CopilotCli] Got token from macOS keychain');
				}
			} catch {
				debugLog('[CopilotCli] Keychain lookup failed');
			}
		}

		// 3. Try Linux secret service
		if (!token && this.deps.platform === 'linux') {
			try {
				const { stdout } = await this.deps.exec(
					`secret-tool lookup service copilot-cli account "${user.host}:${user.login}" 2>/dev/null`
				);
				token = stdout.trim() || null;
				if (token) {
					debugLog('[CopilotCli] Got token from Linux secret-tool');
				}
			} catch {
				debugLog('[CopilotCli] secret-tool lookup failed');
			}
		}

		// 4. Fallback to hosts.json file
		if (!token) {
			const hostsFile = joinPath(this.copilotDir, 'hosts.json');
			const hosts = await this.deps.readJsonFile<Record<string, { oauth_token?: string }>>(hostsFile);
			const hostEntry = hosts?.[user.host];
			token = hostEntry?.oauth_token || null;
			if (token) {
				debugLog('[CopilotCli] Got token from hosts.json');
			}
		}

		// Store token for future use (avoids future keychain prompts)
		if (token) {
			await this.storeToken(token);
		}

		return token;
	}

	private async storeToken(token: string): Promise<void> {
		if (this.deps.secrets) {
			try {
				await this.deps.secrets.store(TOKEN_SECRET_KEY, token);
				debugLog('[CopilotCli] Stored token in SecretStorage');
			} catch {
				debugLog('[CopilotCli] Failed to store token in SecretStorage');
			}
		}
		// Also keep in memory as fallback
		this.memoryToken = token;
	}

	private async clearStoredToken(): Promise<void> {
		if (this.deps.secrets) {
			try {
				await this.deps.secrets.delete(TOKEN_SECRET_KEY);
			} catch {
				// Ignore
			}
		}
		this.memoryToken = null;
	}

	/**
	 * Fetch usage data from GitHub Copilot API
	 * Uses the same endpoint as vscodeCopilot
	 */
	private async fetchUsageFromAPI(token: string): Promise<UsageData | null> {
		debugLog('[CopilotCli] fetchUsageFromAPI called');

		if (!this.deps.fetch) {
			debugLog('[CopilotCli] fetch not available');
			return null;
		}

		try {
			const response = await this.deps.fetch(COPILOT_ENTITLEMENT_URL, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Accept': 'application/json',
				},
				signal: AbortSignal.timeout(5000),
			});

			if (response.status === 200) {
				const payload = await response.json() as CopilotEntitlementResponse;
				return this.parseUsageResponse(payload);
			}

			if (response.status === 429) {
				// Rate limited - return cached data
				return this.cachedData;
			}

			throw new Error(`API returned status ${response.status}`);
		} catch (error) {
			throw new Error(`Failed to fetch usage: ${error}`);
		}
	}

	/**
	 * Parse GitHub Copilot API response into our UsageData format
	 * Standalone implementation that doesn't depend on vscode
	 */
	private parseUsageResponse(response: CopilotEntitlementResponse): UsageData | null {
		const snapshot = this.normalizeEntitlementResponse(response);
		if (!snapshot) {
			return null;
		}

		// Don't show if unlimited
		if (snapshot.unlimited || snapshot.quota <= 0) {
			return null;
		}

		return {
			serviceId: this.serviceId,
			serviceName: SERVICE_NAME,
			totalUsed: Math.max(0, Math.round(snapshot.used)),
			totalLimit: Math.round(snapshot.quota),
			resetTime: snapshot.resetDate,
			quotaWindows: snapshot.quotaWindows,
			lastUpdated: new Date(snapshot.observedAt),
		};
	}

	/**
	 * Normalize the entitlement response into a quota snapshot
	 */
	private normalizeEntitlementResponse(payload: CopilotEntitlementResponse): ParsedQuotaSnapshot | null {
		const buckets = this.extractBuckets(payload);
		if (buckets.length === 0) {
			return null;
		}

		const selectedBucket = this.pickBucket(buckets);
		if (!selectedBucket) {
			return null;
		}

		const resetDate = this.toDate(
			payload.quota_reset_date_utc
			?? payload.quota_reset_date
			?? payload.limited_user_reset_date
		);

		return {
			quota: selectedBucket.quota,
			used: selectedBucket.used,
			resetDate,
			quotaWindows: this.buildQuotaWindows(buckets, resetDate),
			unlimited: selectedBucket.unlimited || selectedBucket.quota === -1,
			observedAt: this.deps.now(),
		};
	}

	private extractBuckets(payload: CopilotEntitlementResponse): Array<{
		name: string;
		quota: number;
		used: number;
		percentRemaining: number;
		unlimited: boolean;
	}> {
		const buckets: Array<{
			name: string;
			quota: number;
			used: number;
			percentRemaining: number;
			unlimited: boolean;
		}> = [];

		// Extract from monthly_quotas + limited_user_quotas
		const pushLimitedBucket = (name: 'chat' | 'completions', totalValue: unknown, remainingValue: unknown): void => {
			const total = this.toFiniteNumber(totalValue);
			const remaining = this.toFiniteNumber(remainingValue);
			if (total === null || remaining === null || total <= 0) {
				return;
			}

			const percentRemaining = Math.max(0, Math.min(100, (remaining / total) * 100));
			buckets.push({
				name,
				quota: total,
				used: Math.max(0, total - remaining),
				percentRemaining,
				unlimited: false,
			});
		};

		pushLimitedBucket(
			'chat',
			payload.monthly_quotas?.chat,
			payload.limited_user_quotas?.chat
		);
		pushLimitedBucket(
			'completions',
			payload.monthly_quotas?.completions,
			payload.limited_user_quotas?.completions
		);

		// Extract from quota_snapshots
		const snapshotBuckets = payload.quota_snapshots;
		if (snapshotBuckets && typeof snapshotBuckets === 'object') {
			const bucketNames = ['premium_interactions', 'premium_models', 'chat', 'completions'] as const;
			for (const name of bucketNames) {
				const bucket = snapshotBuckets[name];
				if (!bucket || typeof bucket !== 'object') {
					continue;
				}

				const quota = this.toFiniteNumber(bucket.entitlement);
				const percentRemaining = this.toFiniteNumber(bucket.percent_remaining);
				if (quota === null || percentRemaining === null) {
					continue;
				}

				const explicitRemaining = this.toFiniteNumber(bucket.remaining);
				const remaining = explicitRemaining ?? Math.max(0, quota * (percentRemaining / 100));
				buckets.push({
					name,
					quota,
					used: Math.max(0, quota - remaining),
					percentRemaining: Math.max(0, Math.min(100, percentRemaining)),
					unlimited: Boolean(bucket.unlimited) || quota === -1,
				});
			}
		}

		return buckets;
	}

	private pickBucket(buckets: Array<{
		name: string;
		quota: number;
		used: number;
		percentRemaining: number;
		unlimited: boolean;
	}>): { quota: number; used: number; unlimited: boolean } | null {
		const boundedBuckets = buckets.filter(bucket => !bucket.unlimited && bucket.quota > 0);
		const chatBucket = boundedBuckets.find(bucket => bucket.name === 'chat');
		if (chatBucket) {
			return chatBucket;
		}

		const premiumBoundedBucket = boundedBuckets.find(bucket =>
			bucket.name === 'premium_interactions' || bucket.name === 'premium_models'
		);

		if (premiumBoundedBucket) {
			return premiumBoundedBucket;
		}

		if (boundedBuckets.length > 0) {
			return boundedBuckets
				.slice()
				.sort((left, right) => left.percentRemaining - right.percentRemaining)[0] ?? null;
		}

		return buckets.find(bucket =>
			bucket.name === 'premium_interactions' || bucket.name === 'premium_models'
		) ?? buckets[0] ?? null;
	}

	private buildQuotaWindows(
		buckets: Array<{
			name: string;
			quota: number;
			used: number;
			percentRemaining: number;
			unlimited: boolean;
		}>,
		resetDate?: Date
	): QuotaWindowUsage[] | undefined {
		const getLabel = (name: string): string => {
			switch (name) {
				case 'chat': return 'Chat messages';
				case 'completions': return 'Inline suggestions';
				case 'premium_interactions': return 'Premium chat';
				case 'premium_models': return 'Premium models';
				default: return name;
			}
		};

		const getSortOrder = (name: string): number => {
			switch (name) {
				case 'chat': return 0;
				case 'completions': return 1;
				case 'premium_interactions': return 2;
				case 'premium_models': return 3;
				default: return 4;
			}
		};

		const windows = buckets
			.filter(bucket => !bucket.unlimited && bucket.quota > 0)
			.filter(bucket => bucket.name === 'chat' || bucket.name === 'completions')
			.sort((left, right) => getSortOrder(left.name) - getSortOrder(right.name))
			.map(bucket => ({
				label: getLabel(bucket.name),
				used: Math.round(bucket.used),
				limit: Math.round(bucket.quota),
				resetTime: resetDate,
			}));

		return windows.length > 0 ? windows : undefined;
	}

	private toFiniteNumber(value: unknown): number | null {
		if (typeof value === 'number') {
			return Number.isFinite(value) ? value : null;
		}
		if (typeof value === 'string' && value.trim() !== '') {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	private toDate(value: unknown): Date | undefined {
		if (value instanceof Date && !Number.isNaN(value.getTime())) {
			return value;
		}
		if (typeof value === 'string' || typeof value === 'number') {
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? undefined : parsed;
		}
		return undefined;
	}
}
