import { UsageProvider } from './base';
import { ServiceHealth, UsageData } from '../types';
import * as vscode from 'vscode';
import { exec as defaultExec } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
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

interface LocalLanguageServerProcess {
	pid: number;
	csrfToken: string;
	extensionServerPort: number;
}

interface LocalUserStatusModelConfig {
	label?: string;
	modelOrAlias?: {
		model?: string;
	};
	disabled?: boolean;
	isInternal?: boolean;
	quotaInfo?: {
		remainingFraction?: number;
		resetTime?: string;
	};
}

interface LocalUserStatusResponse {
	userStatus?: {
		cascadeModelConfigData?: {
			clientModelConfigs?: LocalUserStatusModelConfig[];
		};
	};
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
	getAuthSession?: () => Promise<{ accessToken: string; scopes?: readonly string[] } | null>;
	exec?: (command: string) => Promise<{ stdout: string; stderr: string }>;
	requestLocalStatus?: (port: number, csrfToken: string) => Promise<LocalUserStatusResponse | null>;
}

const GOOGLE_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const GOOGLE_OAUTH_CLIENT_SECRET = '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';
const WINDOWS_LOG_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const execAsync = promisify(defaultExec);
const WINDOWS_AUTHENTICATED_LOG_MARKERS = [
	'URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
	'URL: https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
	'URL: https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
	'URL: https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];
const WINDOWS_SIGNED_IN_LOG_MARKERS = [
	'Auth state changed to: signedIn',
];
const WINDOWS_REAUTH_LOG_MARKERS = [
	'Auth state changed to: signedOut',
	'Failed to get OAuth token',
	'state syncing error: key not found',
];

/**
 * Main Antigravity provider that discovers quota groups
 * and registers sub-providers for each group
 */
export class AntigravityProvider extends UsageProvider {
	readonly serviceId = 'antigravity' as const;
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
			exec: deps.exec ?? (async (command: string) => {
				const result = await execAsync(command);
				return {
					stdout: result.stdout,
					stderr: result.stderr ?? '',
				};
			}),
			getAuthSession: deps.getAuthSession ?? (async () => {
				const session = await vscode.authentication.getSession('antigravity_auth', [], {
					silent: true,
					createIfNone: false,
				});
				if (!session) {
					return null;
				}
				return {
					accessToken: session.accessToken,
					scopes: session.scopes,
				};
			}),
			requestLocalStatus: deps.requestLocalStatus ?? ((port, csrfToken) => this.requestLocalUserStatus(port, csrfToken)),
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
		const localResponse = await this.fetchQuotaFromWindowsLocalService();
		if (localResponse?.models && Object.keys(localResponse.models).length > 0) {
			this.cachedResponse = localResponse;
			this.responseCacheExpiry = this.deps.now() + this.CACHE_TTL;
			return true;
		}
		const token = await this.getAccessToken();
		const fallbackHealth = token === null ? this.findWindowsLogFallbackHealth() : null;
		return token !== null || fallbackHealth !== null;
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
		this.account = this.loadAccount();
		if (!this.account) {
			const authToken = await this.getAuthTokenFromSession();
			if (authToken) {
				return authToken;
			}
			return null;
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
				const authToken = await this.getAuthTokenFromSession();
				if (authToken) {
					return authToken;
				}
				return null;
			}
		}

		return this.account.accessToken;
	}

	private isAntigravityLanguageServerCommand(commandLine: string): boolean {
		const lowerCommand = commandLine.toLowerCase();
		return /--app_data_dir\s+antigravity\b/i.test(commandLine)
			|| lowerCommand.includes('\\antigravity\\')
			|| lowerCommand.includes('/antigravity/');
	}

	private parsePowerShellJson(stdout: string): unknown {
		const trimmed = stdout.trim();
		if (!trimmed) {
			return [];
		}
		return JSON.parse(trimmed);
	}

	private async execPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
		const escapedScript = script.replace(/"/g, '\\"');
		return this.deps.exec(`powershell -NoProfile -Command "${escapedScript}"`);
	}

	private async listWindowsLocalLanguageServerProcesses(): Promise<LocalLanguageServerProcess[]> {
		if (this.deps.platform !== 'win32') {
			return [];
		}

		try {
			const { stdout } = await this.execPowerShell(
				"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'language_server_windows_x64.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Depth 3"
			);
			const parsed = this.parsePowerShellJson(stdout);
			const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
			const processes = items
				.map(item => {
					const value = item as { ProcessId?: number; CommandLine?: string };
					const commandLine = value.CommandLine ?? '';
					if (!value.ProcessId || !commandLine || !this.isAntigravityLanguageServerCommand(commandLine)) {
						return null;
					}
					const csrfToken = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i)?.[1];
					if (!csrfToken) {
						return null;
					}
					const extensionServerPort = Number(commandLine.match(/--extension_server_port[=\s]+(\d+)/i)?.[1] ?? 0);
					return {
						pid: value.ProcessId,
						csrfToken,
						extensionServerPort,
					};
				})
				.filter((value): value is LocalLanguageServerProcess => value !== null);
			return processes;
		} catch (error) {
			return [];
		}
	}

	private async listWindowsListeningPorts(pid: number, extensionServerPort: number): Promise<number[]> {
		const ports = new Set<number>();
		if (extensionServerPort > 0) {
			ports.add(extensionServerPort);
		}

		try {
			const { stdout } = await this.execPowerShell(
				`Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Depth 3`
			);
			const parsed = this.parsePowerShellJson(stdout);
			const values = Array.isArray(parsed) ? parsed : [parsed];
			for (const value of values) {
				if (typeof value === 'number' && value > 0) {
					ports.add(value);
				}
			}
		} catch {
			// Ignore process inspection failures and fall back to known ports.
		}

		return [...ports].sort((a, b) => a - b);
	}

	private async requestLocalUserStatus(port: number, csrfToken: string): Promise<LocalUserStatusResponse | null> {
		return new Promise(resolve => {
			const request = https.request({
				hostname: '127.0.0.1',
				port,
				path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Connect-Protocol-Version': '1',
					'X-Codeium-Csrf-Token': csrfToken,
				},
				rejectUnauthorized: false,
				timeout: 5000,
			}, response => {
				let body = '';
				response.on('data', chunk => {
					body += chunk.toString();
				});
				response.on('end', () => {
					if (response.statusCode !== 200) {
						resolve(null);
						return;
					}
					try {
						resolve(JSON.parse(body) as LocalUserStatusResponse);
					} catch {
						resolve(null);
					}
				});
			});

			request.on('error', () => resolve(null));
			request.on('timeout', () => {
				request.destroy();
				resolve(null);
			});
			request.write(JSON.stringify({
				metadata: {
					ideName: 'antigravity',
					extensionName: 'antigravity',
					locale: 'en',
				},
			}));
			request.end();
		});
	}

	private mapLocalUserStatusToQuotaResponse(localStatus: LocalUserStatusResponse): AuthorizedQuotaResponse {
		const response: AuthorizedQuotaResponse = {
			models: {},
			agentModelSorts: [],
		};
		const modelIds: string[] = [];
		const configs = localStatus.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];

		for (const [index, config] of configs.entries()) {
			const baseModelId = config.modelOrAlias?.model || config.label || `local_model_${index}`;
			let modelId = baseModelId;
			let suffix = 1;
			while (response.models?.[modelId]) {
				modelId = `${baseModelId}_${suffix}`;
				suffix += 1;
			}
			response.models![modelId] = {
				displayName: config.label || baseModelId,
				model: config.modelOrAlias?.model || baseModelId,
				disabled: config.disabled,
				isInternal: config.isInternal,
				quotaInfo: config.quotaInfo ? {
					remainingFraction: config.quotaInfo.remainingFraction,
					resetTime: config.quotaInfo.resetTime,
				} : undefined,
			};
			modelIds.push(modelId);
		}

		if (modelIds.length > 0) {
			response.agentModelSorts = [{ groups: [{ modelIds }] }];
		}

		return response;
	}

	private async fetchQuotaFromWindowsLocalService(): Promise<AuthorizedQuotaResponse | null> {
		if (this.deps.platform !== 'win32') {
			return null;
		}

		const processes = await this.listWindowsLocalLanguageServerProcesses();
		for (const process of processes) {
			const ports = await this.listWindowsListeningPorts(process.pid, process.extensionServerPort);
			for (const port of ports) {
				const localStatus = await this.deps.requestLocalStatus(port, process.csrfToken);
				if (!localStatus) {
					continue;
				}
				const response = this.mapLocalUserStatusToQuotaResponse(localStatus);
				const modelCount = Object.keys(response.models || {}).length;
				if (modelCount > 0) {
					return response;
				}
			}
		}

		return null;
	}

	private async getAuthTokenFromSession(): Promise<string | null> {
		try {
			const session = await this.deps.getAuthSession();
			return session?.accessToken ?? null;
		} catch {
			return null;
		}
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

	private getWindowsStateDbPath(): string {
		return path.join(this.deps.homeDir, 'AppData', 'Roaming', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
	}

	private getWindowsLogsRootPath(): string {
		return path.join(this.deps.homeDir, 'AppData', 'Roaming', 'Antigravity', 'logs');
	}

	private buildWindowsLogFallbackHealth(logPath: string): ServiceHealth {
		return {
			kind: 'unavailable',
			summary: 'Antigravity is signed in, but quota data is unavailable on Windows.',
			detail: `Recent Antigravity logs in ${path.basename(logPath)} show a signed-in or authenticated state, but mana-bar could not read quota groups on Windows.`,
			lastUpdated: new Date(this.deps.now()),
		};
	}

	private buildWindowsReauthHealth(logPath: string): ServiceHealth {
		return {
			kind: 'reauthRequired',
			summary: 'Antigravity needs you to sign in again.',
			detail: `Antigravity reported a missing OAuth auth state in ${path.basename(logPath)}, so mana-bar could not read quota data on Windows.`,
			lastUpdated: new Date(this.deps.now()),
		};
	}

	private findWindowsLogFallbackHealth(): ServiceHealth | null {
		if (this.deps.platform !== 'win32') {
			return null;
		}

		const logsRoot = this.getWindowsLogsRootPath();
		if (!this.deps.existsSync(logsRoot)) {
			return null;
		}

		let checkedLogCount = 0;
		let matchedLogPath: string | null = null;
		let matchedMarker: string | null = null;

		try {
			const runDirectories = this.deps.readdirSync(logsRoot)
				.map(name => path.join(logsRoot, name))
				.filter(fullPath => this.deps.existsSync(fullPath))
				.sort((a, b) => this.deps.statSync(b).mtimeMs - this.deps.statSync(a).mtimeMs)
				.slice(0, 3);

			for (const runDir of runDirectories) {
				const authLogPath = path.join(runDir, 'auth.log');
				const candidateLogs = [
					path.join(runDir, 'window1', 'exthost', 'google.antigravity', 'Antigravity.log'),
					path.join(runDir, 'ls-main.log'),
				];
				let signedInLogPath: string | null = null;
				let authenticatedLogPath: string | null = null;
				let reauthLogPath: string | null = null;

				if (this.deps.existsSync(authLogPath)) {
					const ageMs = this.deps.now() - this.deps.statSync(authLogPath).mtimeMs;
					if (ageMs <= WINDOWS_LOG_FALLBACK_MAX_AGE_MS) {
						const authContent = this.deps.readFileSync(authLogPath, 'utf-8');
						if (WINDOWS_SIGNED_IN_LOG_MARKERS.some(value => authContent.includes(value))) {
							signedInLogPath = authLogPath;
						} else if (WINDOWS_REAUTH_LOG_MARKERS.some(value => authContent.includes(value))) {
							reauthLogPath = authLogPath;
						}
					}
				}

				for (const logPath of candidateLogs) {
					if (!this.deps.existsSync(logPath)) {
						continue;
					}

					checkedLogCount += 1;
					const ageMs = this.deps.now() - this.deps.statSync(logPath).mtimeMs;
					if (ageMs > WINDOWS_LOG_FALLBACK_MAX_AGE_MS) {
						continue;
					}

					const content = this.deps.readFileSync(logPath, 'utf-8');
					if (WINDOWS_AUTHENTICATED_LOG_MARKERS.some(value => content.includes(value))) {
						authenticatedLogPath = logPath;
						continue;
					}
					if (!reauthLogPath && WINDOWS_REAUTH_LOG_MARKERS.some(value => content.includes(value))) {
						reauthLogPath = logPath;
					}
				}

				if (authenticatedLogPath || signedInLogPath) {
					const successLogPath = authenticatedLogPath ?? signedInLogPath;
					if (successLogPath) {
						matchedLogPath = successLogPath;
						return this.buildWindowsLogFallbackHealth(successLogPath);
					}
				}
				if (reauthLogPath) {
					return this.buildWindowsReauthHealth(reauthLogPath);
				}
			}
		} catch (error) {
			debugLog('[Antigravity] Failed to scan Windows log fallback:', error);
			return null;
		}
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
			response = await this.fetchQuotaFromWindowsLocalService();
		}

		if (!response) {
			const token = await this.getAccessToken();
			if (!token) {
				const fallbackHealth = this.findWindowsLogFallbackHealth();
				if (fallbackHealth) {
					registerCallback(new AntigravityHealthFallbackProvider(fallbackHealth));
					this.hasDiscovered = true;
					debugLog('[Antigravity] Registered Windows log fallback provider');
					return;
				}
				debugLog('[Antigravity] No cached data or auth token found, skipping');
				return;
			}
			response = await this.fetchQuotaFromAPI(token);
		}

		if (!response || !response.models) {
			const fallbackHealth = this.findWindowsLogFallbackHealth();
			if (fallbackHealth) {
				registerCallback(new AntigravityHealthFallbackProvider(fallbackHealth));
				this.hasDiscovered = true;
				debugLog('[Antigravity] Registered Windows log fallback provider after missing quota response');
				return;
			}
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
			response = await this.fetchQuotaFromWindowsLocalService();
		}

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
class AntigravityHealthFallbackProvider extends UsageProvider {
	readonly serviceId = 'antigravity' as const;

	constructor(private readonly health: ServiceHealth) {
		super();
	}

	getServiceName(): string {
		return 'Antigravity';
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<UsageData | null> {
		return null;
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	override getLastServiceHealth(): ServiceHealth | null {
		return this.health;
	}
}

/**
 * Sub-provider for a specific Antigravity quota group
 */
class AntigravityQuotaGroupProvider extends UsageProvider {
	readonly serviceId = 'antigravity' as const;
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
