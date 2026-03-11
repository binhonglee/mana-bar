import { UsageProvider } from './base';
import { UsageData } from '../types';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	filterAntigravityModelsInGroup,
	getAntigravityGroupName,
	groupAntigravityModelsByQuota,
	parseAntigravityQuotaForGroup,
	resolveAntigravityAutoGroupFamily,
} from './antigravity-parse';
import { debugLog, debugWarn } from '../logger';

/**
 * Antigravity API response structures
 */
interface AuthorizedModelSortGroup {
	modelIds?: string[];
}

interface AuthorizedModelSort {
	groups?: AuthorizedModelSortGroup[];
}

interface AuthorizedQuotaResponse {
	models?: Record<string, ModelInfo>;
	agentModelSorts?: AuthorizedModelSort[];
}


interface ModelInfo {
	displayName?: string;
	model?: string;
	disabled?: boolean;
	quotaInfo?: {
		remainingFraction?: number; // 0-1 (e.g., 0.75 = 75%)
		resetTime?: string; // ISO 8601 date string
	};
	tagTitle?: string; // Quota group name (e.g., "Gemini 2.0 Flash")
	isInternal?: boolean;
}

interface AntigravityAccount {
	email: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix timestamp (seconds or ms)
	projectId: string;
}

export interface AntigravityProviderDeps {
	now?: () => number;
	homeDir?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	fetch?: typeof fetch;
	existsSync?: typeof fs.existsSync;
	readFileSync?: typeof fs.readFileSync;
	readdirSync?: typeof fs.readdirSync;
	statSync?: typeof fs.statSync;
}

const GOOGLE_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const GOOGLE_OAUTH_CLIENT_SECRET = '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';

/**
 * Main Antigravity provider that discovers quota groups
 * and registers sub-providers for each group
 */
export class AntigravityProvider extends UsageProvider {
	private readonly CACHE_TTL = 60 * 1000; // 60 seconds
	private context: vscode.ExtensionContext;
	private hasDiscovered = false;
	private cachedResponse: AuthorizedQuotaResponse | null = null;
	private responseCacheExpiry: number = 0;
	private account: AntigravityAccount | null = null;
	private readonly deps: Required<AntigravityProviderDeps>;

	constructor(context: vscode.ExtensionContext, deps: AntigravityProviderDeps = {}) {
		super();
		this.context = context;
		this.deps = {
			now: deps.now ?? Date.now,
			homeDir: deps.homeDir ?? os.homedir(),
			platform: deps.platform ?? process.platform,
			arch: deps.arch ?? process.arch,
			fetch: deps.fetch ?? fetch,
			existsSync: deps.existsSync ?? fs.existsSync,
			readFileSync: deps.readFileSync ?? fs.readFileSync,
			readdirSync: deps.readdirSync ?? fs.readdirSync,
			statSync: deps.statSync ?? fs.statSync,
		};
	}

	getServiceName(): string {
		return 'Antigravity';
	}

	async isAvailable(): Promise<boolean> {
		const cached = await this.readCachedQuotaData();
		if (cached) {
			return true;
		}
		const token = await this.getAccessToken();
		return token !== null;
	}

	async getUsage(): Promise<UsageData | null> {
		return null;
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	/**
	 * Try to read cached quota data directly from the cockpit extension's cache files.
	 */
	private async readCachedQuotaData(): Promise<AuthorizedQuotaResponse | null> {
		const knownFiles = [
			path.join(this.deps.homeDir, '.antigravity_cockpit', 'cache', 'quota_api_v1_plugin', 'authorized'),
			path.join(this.deps.homeDir, '.antigravity_cockpit', 'cache', 'quota_api_v1', 'authorized'),
		];

		for (const filePath of knownFiles) {
			const result = await this.tryReadCacheFile(filePath);
			if (result) {
				return result;
			}
		}

		const cacheDirs = [
			path.join(this.deps.homeDir, '.antigravity_cockpit', 'cache', 'quota_api_v1_plugin'),
			path.join(this.deps.homeDir, '.antigravity_cockpit', 'cache', 'quota_api_v1'),
			path.join(this.deps.homeDir, '.antigravity_cockpit', 'cache'),
		];

		for (const cacheDir of cacheDirs) {
			try {
				if (!this.deps.existsSync(cacheDir)) {
					continue;
				}

				const allFiles = this.deps.readdirSync(cacheDir)
					.filter(f => {
						const fullPath = path.join(cacheDir, f);
						return this.deps.statSync(fullPath).isFile();
					});
				debugLog(`[Antigravity] Cache dir ${cacheDir}: files: ${allFiles.join(', ')}`);

				const sortedFiles = allFiles
					.map(f => ({ name: f, mtime: this.deps.statSync(path.join(cacheDir, f)).mtimeMs }))
					.sort((a, b) => b.mtime - a.mtime);

				for (const file of sortedFiles) {
					const result = await this.tryReadCacheFile(path.join(cacheDir, file.name));
					if (result) {
						return result;
					}
				}
			} catch (error) {
				debugLog(`[Antigravity] Failed to scan ${cacheDir}:`, error);
			}
		}

		return null;
	}

	private async tryReadCacheFile(filePath: string): Promise<AuthorizedQuotaResponse | null> {
		try {
			if (!this.deps.existsSync(filePath)) {
				return null;
			}

			const content = this.deps.readFileSync(filePath, 'utf-8');
			const cached = JSON.parse(content);
			const keys = Object.keys(cached);
			debugLog(`[Antigravity] File ${filePath}: keys=${keys.join(', ')}`);

			const data = cached.payload || cached;

			if (data.models) {
				const modelKeys = Object.keys(data.models);
				debugLog(`[Antigravity] Found ${modelKeys.length} models in ${filePath}`);
				if (modelKeys.length > 0) {
					const firstModel = data.models[modelKeys[0]];
					debugLog(`[Antigravity] Sample model "${modelKeys[0]}": keys=${Object.keys(firstModel).join(', ')}, quotaInfo=${JSON.stringify(firstModel.quotaInfo)}, tagTitle=${firstModel.tagTitle}`);
				}

				const hasQuota = modelKeys.some(k => data.models[k].quotaInfo);
				if (hasQuota) {
					debugLog(`[Antigravity] Loaded quota data from ${filePath}`);
					return data as AuthorizedQuotaResponse;
				}
				debugLog(`[Antigravity] Models found but none have quotaInfo`);
			}
		} catch {
			// Not valid JSON or unreadable - skip silently
		}
		return null;
	}

	/**
	 * Load account info and return a valid access token (refreshing if expired)
	 */
	private async getAccessToken(): Promise<string | null> {
		if (!this.account) {
			this.account = this.loadAccount();
			if (!this.account) {
				return null;
			}
		}

		const now = this.deps.now();
		let expiresAtMs: number;
		if (typeof this.account.expiresAt === 'string') {
			expiresAtMs = new Date(this.account.expiresAt).getTime();
		} else {
			expiresAtMs = this.account.expiresAt > 1e12 ? this.account.expiresAt : this.account.expiresAt * 1000;
		}

		if (isNaN(expiresAtMs) || now >= expiresAtMs - 60000) {
			debugLog(`[Antigravity] Token expired (expiresAt: ${isNaN(expiresAtMs) ? 'NaN' : new Date(expiresAtMs).toISOString()}), refreshing...`);
			const refreshed = await this.refreshAccessToken();
			if (!refreshed) {
				debugLog('[Antigravity] Token refresh failed');
				return null;
			}
		}

		return this.account.accessToken;
	}

	/**
	 * Load account from credentials.json
	 */
	private loadAccount(): AntigravityAccount | null {
		const configPaths = [
			path.join(this.deps.homeDir, '.antigravity_cockpit', 'credentials.json'),
		];

		for (const configPath of configPaths) {
			try {
				if (!this.deps.existsSync(configPath)) {
					continue;
				}
				const content = this.deps.readFileSync(configPath, 'utf-8');
				const config = JSON.parse(content);

				const accounts = config.accounts;
				if (!accounts) {
					continue;
				}

				const accountList = Array.isArray(accounts) ? accounts : Object.values(accounts);
				for (const account of accountList as AntigravityAccount[]) {
					if (account.accessToken && account.refreshToken) {
						debugLog(`[Antigravity] Loaded account: ${account.email}, projectId: ${account.projectId}, expiresAt: ${account.expiresAt} (type: ${typeof account.expiresAt})`);
						return account;
					}
				}
			} catch (error) {
				debugLog(`[Antigravity] Failed to read ${configPath}:`, error);
			}
		}

		debugLog('[Antigravity] No account found');
		return null;
	}

	/**
	 * Refresh the access token using the refresh token
	 */
	private async refreshAccessToken(): Promise<boolean> {
		if (!this.account?.refreshToken) {
			return false;
		}

		try {
			const response = await this.deps.fetch('https://oauth2.googleapis.com/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: this.account.refreshToken,
					client_id: GOOGLE_OAUTH_CLIENT_ID,
					client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
				}).toString(),
				signal: AbortSignal.timeout(10000),
			});

			if (!response.ok) {
				const text = await response.text().catch(() => '');
				console.error(`[Antigravity] Token refresh failed: ${response.status} ${text.slice(0, 300)}`);
				return false;
			}

			const data = await response.json() as { access_token: string; expires_in: number };
			this.account.accessToken = data.access_token;
			this.account.expiresAt = this.deps.now() + (data.expires_in * 1000);
			debugLog(`[Antigravity] Token refreshed, new expiry: ${new Date(this.account.expiresAt).toISOString()}`);
			return true;
		} catch (error) {
			console.error('[Antigravity] Token refresh error:', error);
			return false;
		}
	}

	/**
	 * Discover quota groups and register sub-providers
	 */
	async discoverQuotaGroups(registerCallback: (provider: UsageProvider) => void): Promise<void> {
		debugLog('[Antigravity] Starting quota group discovery...');

		if (this.hasDiscovered) {
			debugLog('[Antigravity] Already discovered, skipping');
			return;
		}

		let response = await this.readCachedQuotaData();

		if (!response) {
			const token = await this.getAccessToken();
			if (!token) {
				debugLog('[Antigravity] No cached data or auth token found, skipping');
				return;
			}
			response = await this.fetchQuotaFromAPI(token);
		}

		if (!response || !response.models) {
			debugLog('[Antigravity] No quota data available');
			return;
		}

		// Cache the discovery response so sub-providers don't re-fetch immediately
		this.cachedResponse = response;
		this.responseCacheExpiry = this.deps.now() + this.CACHE_TTL;

		const quotaGroups = this.groupModelsByQuota(response);
		debugLog(`[Antigravity] Discovered ${quotaGroups.size} quota group(s): ${[...quotaGroups.keys()].join(', ')}`);

		for (const [groupName, models] of quotaGroups.entries()) {
			const subProvider = new AntigravityQuotaGroupProvider(
				groupName,
				models.map(m => m.model || ''),
				this,
			);
			registerCallback(subProvider);
			debugLog(`[Antigravity] Registered sub-provider: Antigravity ${groupName} (${models.length} models)`);
		}

		this.hasDiscovered = true;
	}

	/**
	 * Get the latest quota response (cached, from filesystem, or from API).
	 * Sub-providers call this so all share one API call.
	 */
	async getQuotaResponse(): Promise<AuthorizedQuotaResponse | null> {
		if (this.cachedResponse && this.deps.now() < this.responseCacheExpiry) {
			return this.cachedResponse;
		}

		let response = await this.readCachedQuotaData();

		if (!response) {
			const token = await this.getAccessToken();
			if (token) {
				response = await this.fetchQuotaFromAPI(token);
			}
		}

		if (response) {
			this.cachedResponse = response;
			this.responseCacheExpiry = this.deps.now() + this.CACHE_TTL;
		}

		return response;
	}

	/**
	 * Group models by quota pool (tagTitle)
	 */
	private groupModelsByQuota(response: AuthorizedQuotaResponse): Map<string, ModelInfo[]> {
		return groupAntigravityModelsByQuota(response);
	}

	public resolveAutoGroupFamily(modelId: string, label?: string): string {
		return resolveAntigravityAutoGroupFamily(modelId, label);
	}

	public getGroupName(family: string): string {
		return getAntigravityGroupName(family);
	}

	getNow(): number {
		return this.deps.now();
	}

	/**
	 * Fetch quota data from Antigravity API
	 * Matches vscode-antigravity-cockpit cloudcode_client.ts implementation
	 */
	private async fetchQuotaFromAPI(accessToken: string): Promise<AuthorizedQuotaResponse | null> {
		const projectId = this.account?.projectId;
		const platform = this.deps.platform === 'darwin' ? 'macos' : this.deps.platform;
		const arch = this.deps.arch === 'arm64' ? 'arm64' : 'x86_64';
		const userAgent = `antigravity/1.0.0 ${platform}/${arch}`;

		// Cockpit defaults to daily endpoint, falls back to prod
		const endpoints = [
			'https://daily-cloudcode-pa.googleapis.com',
			'https://cloudcode-pa.googleapis.com',
		];

		for (const baseUrl of endpoints) {
			const url = `${baseUrl}/v1internal:fetchAvailableModels`;
			try {
				debugLog(`[Antigravity] Fetching quota from ${baseUrl} (projectId: ${projectId})`);
				const response = await this.deps.fetch(url, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${accessToken}`,
						'User-Agent': userAgent,
						'Content-Type': 'application/json',
						'Accept-Encoding': 'gzip',
					},
					body: JSON.stringify(projectId ? { project: projectId } : {}),
					signal: AbortSignal.timeout(10000),
				});

				if (response.status === 401) {
					this.account = null;
					return null; // Auth error, no point trying other endpoints
				}

				if (!response.ok) {
					const text = await response.text().catch(() => '');
					debugWarn(`[Antigravity] ${baseUrl} returned ${response.status}: ${text.slice(0, 300)}`);
					continue; // Try next endpoint
				}

				const data = await response.json() as AuthorizedQuotaResponse;
				debugLog(`[Antigravity] API returned ${Object.keys(data.models || {}).length} models`);
				if (data.models) {
					const firstKey = Object.keys(data.models)[0];
					if (firstKey) {
						const sample = data.models[firstKey];
						debugLog(`[Antigravity] API sample model "${firstKey}": keys=${Object.keys(sample).join(', ')}, quotaInfo=${JSON.stringify(sample.quotaInfo)}, tagTitle=${sample.tagTitle}`);
					}
				}
				return data;
			} catch (error) {
				debugWarn(`[Antigravity] ${baseUrl} request failed:`, error);
				continue; // Try next endpoint
			}
		}

		console.error('[Antigravity] All API endpoints failed');
		return null;
	}
}

/**
 * Sub-provider for a specific Antigravity quota group
 */
class AntigravityQuotaGroupProvider extends UsageProvider {
	constructor(
		private groupName: string,
		private modelsInGroup: string[],
		private parent: AntigravityProvider,
	) {
		super();
	}

	getServiceName(): string {
		if (this.groupName === 'Default') {
			return 'Antigravity';
		}
		return `Antigravity ${this.groupName}`;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<UsageData | null> {
		try {
			const response = await this.parent.getQuotaResponse();
			if (!response || !response.models) {
				return null;
			}

			const groupModels = this.filterModelsInGroup(response);
			if (groupModels.length === 0) {
				return null;
			}

			return this.parseQuotaForGroup(groupModels);
		} catch (error) {
			console.error(`[Antigravity ${this.groupName}] Failed to fetch usage:`, error);
			return null;
		}
	}

	async getModels(): Promise<string[]> {
		return this.modelsInGroup;
	}

	private filterModelsInGroup(response: AuthorizedQuotaResponse): ModelInfo[] {
		return filterAntigravityModelsInGroup(response, this.groupName);
	}

	private parseQuotaForGroup(groupModels: ModelInfo[]): UsageData {
		return parseAntigravityQuotaForGroup(this.getServiceName(), groupModels, new Date(this.parent.getNow()));
	}
}
