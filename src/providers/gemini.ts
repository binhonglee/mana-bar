import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { UsageProvider } from './base';
import { UsageData, ModelUsage } from '../types';
import { fileExists, getHomeDir, joinPath, readJsonFile } from '../utils';
import {
	extractGeminiModelsFromDefaultConfigs,
	extractValidGeminiModels,
	humanizeGeminiModelLabel,
	normalizeGeminiQuotaBuckets,
} from './gemini-parse';
import { getCacheExpiry, getCachedValue, withStaleFallback } from './cache';
import { debugLog, debugWarn } from '../logger';

const execAsync = promisify(exec);

const GEMINI_OAUTH_SERVICE = 'gemini-cli-oauth';
const GEMINI_OAUTH_ACCOUNT = 'main-account';
const GOOGLE_OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GOOGLE_OAUTH_CLIENT_SECRET = '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';

type GeminiDiscoverySource = 'VALID_GEMINI_MODELS' | 'defaultModelConfigs' | 'raw';

interface GeminiSettings {
	security?: {
		auth?: {
			selectedType?: string;
		};
	};
}

interface GoogleOAuthCredentials {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	scope?: string;
	expiry_date?: number;
}

interface KeychainCredentialEnvelope {
	token?: {
		accessToken?: string;
		refreshToken?: string;
		tokenType?: string;
		scope?: string;
		expiresAt?: number;
	};
}

interface LoadCodeAssistResponse {
	currentTier?: {
		id: string;
	};
	cloudaicompanionProject?: string | null;
}

interface RetrieveUserQuotaResponse {
	buckets?: GeminiQuotaBucket[];
}

interface GeminiQuotaBucket {
	remainingAmount?: string;
	remainingFraction?: number;
	resetTime?: string;
	tokenType?: string;
	modelId?: string;
}

interface GeminiCliConfigPaths {
	modelsFile?: string;
	defaultModelConfigsFile?: string;
}

interface GeminiCliDiscoveryResult {
	modelIds: string[];
	source: GeminiDiscoverySource;
}

interface GeminiModelsModule {
	VALID_GEMINI_MODELS?: unknown;
}

interface GeminiDefaultModelConfig {
	modelConfig?: {
		model?: string;
	};
}

interface GeminiDefaultModelConfigsModule {
	DEFAULT_MODEL_CONFIGS?: {
		aliases?: Record<string, GeminiDefaultModelConfig>;
	};
}

export interface GeminiProviderDeps {
	now?: () => number;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	exec?: (command: string) => Promise<{ stdout: string; stderr?: string }>;
	realpath?: (filePath: string) => Promise<string>;
	fileExists?: (filePath: string) => Promise<boolean>;
	readJsonFile?: <T>(filePath: string) => Promise<T | null>;
	importModule?: (specifier: string) => Promise<unknown>;
	fetch?: typeof fetch;
}

/**
 * Parent provider for Gemini CLI usage tracking.
 *
 * This class owns Gemini auth, quota fetching, and local Gemini CLI discovery.
 * Child providers are registered per visible Gemini model.
 */
export class GeminiProvider extends UsageProvider {
	readonly serviceId = 'gemini' as const;
	private readonly CACHE_TTL = 180 * 1000; // 3 minutes
	private readonly CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal';
	private readonly geminiDir: string;
	private readonly settingsFile: string;
	private readonly credentialsFile: string;
	private readonly deps: Required<GeminiProviderDeps>;

	private hasDiscovered = false;
	private discoverySource: GeminiDiscoverySource | null = null;
	private discoveredModelIds: string[] = [];
	private cachedQuotaResponse: RetrieveUserQuotaResponse | null = null;
	private cacheExpiry = 0;
	private availabilityChecked = false;
	private isGeminiAvailable = false;
	private geminiBinaryPathResolved = false;
	private geminiBinaryPath: string | null = null;
	private cliConfigPathsResolved = false;
	private cliConfigPaths: GeminiCliConfigPaths | null = null;

	constructor(deps: GeminiProviderDeps = {}) {
		super();
		this.deps = {
			now: deps.now ?? Date.now,
			platform: deps.platform ?? process.platform,
			env: deps.env ?? process.env,
			homeDir: deps.homeDir ?? getHomeDir(),
			exec: deps.exec ?? execAsync,
			realpath: deps.realpath ?? fs.realpath,
			fileExists: deps.fileExists ?? fileExists,
			readJsonFile: deps.readJsonFile ?? readJsonFile,
			importModule: deps.importModule ?? ((specifier) => import(specifier)),
			fetch: deps.fetch ?? fetch,
		};
		this.geminiDir = joinPath(this.deps.homeDir, '.gemini');
		this.settingsFile = joinPath(this.geminiDir, 'settings.json');
		this.credentialsFile = joinPath(this.geminiDir, 'oauth_creds.json');
	}

	getServiceName(): string {
		return 'Gemini CLI';
	}

	async isAvailable(): Promise<boolean> {
		if (this.availabilityChecked) {
			return this.isGeminiAvailable;
		}

		this.availabilityChecked = true;

		const binaryPath = await this.getGeminiBinaryPath();
		if (!binaryPath) {
			this.isGeminiAvailable = false;
			return false;
		}

		if (!await this.deps.fileExists(this.geminiDir)) {
			this.isGeminiAvailable = false;
			return false;
		}

		const authType = await this.getSelectedAuthType();
		if (authType !== 'oauth-personal') {
			this.isGeminiAvailable = false;
			return false;
		}

		const credentials = await this.getStoredCredentials();
		this.isGeminiAvailable = credentials !== null;
		return this.isGeminiAvailable;
	}

	async getUsage(): Promise<UsageData | null> {
		return null;
	}

	override clearCache(): void {
		this.cachedQuotaResponse = null;
		this.cacheExpiry = 0;
	}

	async getModels(): Promise<string[]> {
		return this.discoveredModelIds;
	}

	async discoverQuotaGroups(registerCallback: (provider: UsageProvider) => void): Promise<void> {
		if (this.hasDiscovered) {
			return;
		}

		if (!await this.isAvailable()) {
			return;
		}

		const discovery = await this.discoverVisibleModelIds();
		if (!discovery || discovery.modelIds.length === 0) {
			debugLog('[Gemini] No Gemini model providers discovered');
			return;
		}

		this.discoverySource = discovery.source;
		this.discoveredModelIds = discovery.modelIds;
		this.hasDiscovered = true;

		debugLog(
			`[Gemini] Discovered ${discovery.modelIds.length} Gemini model provider(s) via ${discovery.source}: ${discovery.modelIds.join(', ')}`
		);

		for (const modelId of discovery.modelIds) {
			registerCallback(new GeminiModelProvider(modelId, this));
		}
	}

	async getQuotaBucketForModel(modelId: string): Promise<GeminiQuotaBucket | null> {
		const response = await this.getQuotaResponse();
		if (!response) {
			return null;
		}

		const allowedModelIds = this.discoveredModelIds.length > 0
			? new Set(this.discoveredModelIds)
			: null;

		const buckets = this.normalizeBuckets(response.buckets || [], allowedModelIds);
		return buckets.find(bucket => bucket.modelId === modelId) || null;
	}

	getServiceNameForModel(modelId: string): string {
		return `Gemini CLI ${this.humanizeModelLabel(modelId)}`;
	}

	toModelUsage(bucket: GeminiQuotaBucket): ModelUsage | null {
		if (!bucket.modelId || bucket.remainingFraction === undefined || bucket.remainingFraction === null) {
			return null;
		}

		const used = Math.max(0, Math.min(100, Math.round((1 - bucket.remainingFraction) * 100)));
		let resetTime: Date | undefined;
		if (bucket.resetTime) {
			const date = new Date(bucket.resetTime);
			if (date.getTime() > 0) {
				resetTime = date;
			}
		}

		if (resetTime === undefined) {
			return null;
		}

		return {
			modelName: bucket.modelId,
			used,
			limit: 100,
			resetTime,
		};
	}

	private async discoverVisibleModelIds(): Promise<GeminiCliDiscoveryResult | null> {
		const fileDiscovery = await this.discoverVisibleModelIdsFromCli();
		if (fileDiscovery && fileDiscovery.modelIds.length > 0) {
			return fileDiscovery;
		}

		const response = await this.getQuotaResponse();
		if (!response?.buckets?.length) {
			return null;
		}

		const buckets = this.normalizeBuckets(response.buckets, null);
		const modelIds = buckets
			.map(bucket => bucket.modelId)
			.filter((modelId): modelId is string => Boolean(modelId));

		if (modelIds.length === 0) {
			return null;
		}

		debugLog('[Gemini] Falling back to raw quota buckets for model discovery');
		return {
			modelIds,
			source: 'raw',
		};
	}

	private async discoverVisibleModelIdsFromCli(): Promise<GeminiCliDiscoveryResult | null> {
		const cliConfigPaths = await this.getCliConfigPaths();
		if (!cliConfigPaths) {
			return null;
		}

		const visibleModels = await this.loadVisibleModelIdsFromModelsModule(cliConfigPaths.modelsFile);
		if (visibleModels.length > 0) {
			return {
				modelIds: visibleModels,
				source: 'VALID_GEMINI_MODELS',
			};
		}

		const fallbackModels = await this.loadVisibleModelIdsFromDefaultConfigs(cliConfigPaths.defaultModelConfigsFile);
		if (fallbackModels.length > 0) {
			return {
				modelIds: fallbackModels,
				source: 'defaultModelConfigs',
			};
		}

		return null;
	}

	private async getCliConfigPaths(): Promise<GeminiCliConfigPaths | null> {
		if (this.cliConfigPathsResolved) {
			return this.cliConfigPaths;
		}

		this.cliConfigPathsResolved = true;

		const binaryPath = await this.getGeminiBinaryPath();
		if (!binaryPath) {
			return null;
		}

		const prefixes: string[] = [];
		let current = path.dirname(binaryPath);

		while (!prefixes.includes(current)) {
			prefixes.push(current);
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}

		const candidateRoots = new Set<string>();
		for (const prefix of prefixes) {
			candidateRoots.add(path.join(prefix, 'libexec', 'lib', 'node_modules', '@google', 'gemini-cli'));
			candidateRoots.add(path.join(prefix, 'lib', 'node_modules', '@google', 'gemini-cli'));
		}

		for (const packageRoot of candidateRoots) {
			const modelsFile = path.join(
				packageRoot,
				'node_modules',
				'@google',
				'gemini-cli-core',
				'dist',
				'src',
				'config',
				'models.js'
			);
			const defaultModelConfigsFile = path.join(
				packageRoot,
				'node_modules',
				'@google',
				'gemini-cli-core',
				'dist',
				'src',
				'config',
				'defaultModelConfigs.js'
			);

			if (!await this.deps.fileExists(modelsFile) && !await this.deps.fileExists(defaultModelConfigsFile)) {
				continue;
			}

			this.cliConfigPaths = {
				modelsFile: await this.deps.fileExists(modelsFile) ? modelsFile : undefined,
				defaultModelConfigsFile: await this.deps.fileExists(defaultModelConfigsFile) ? defaultModelConfigsFile : undefined,
			};

			debugLog(`[Gemini] Resolved Gemini CLI config files under ${packageRoot}`);
			return this.cliConfigPaths;
		}

		debugLog(`[Gemini] Could not resolve Gemini CLI config files from ${binaryPath}`);
		return null;
	}

	private async loadVisibleModelIdsFromModelsModule(modelsFile?: string): Promise<string[]> {
		if (!modelsFile) {
			return [];
		}

		try {
			const module = await this.deps.importModule(pathToFileURL(modelsFile).href) as GeminiModelsModule;
			return extractValidGeminiModels(module);
		} catch (error) {
			debugWarn('[Gemini] Failed to load VALID_GEMINI_MODELS:', error);
			return [];
		}
	}

	private async loadVisibleModelIdsFromDefaultConfigs(defaultModelConfigsFile?: string): Promise<string[]> {
		if (!defaultModelConfigsFile) {
			return [];
		}

		try {
			const module = await this.deps.importModule(pathToFileURL(defaultModelConfigsFile).href) as GeminiDefaultModelConfigsModule;
			return extractGeminiModelsFromDefaultConfigs(module);
		} catch (error) {
			debugWarn('[Gemini] Failed to load defaultModelConfigs fallback:', error);
			return [];
		}
	}

	private normalizeBuckets(
		buckets: GeminiQuotaBucket[],
		allowedModelIds: Set<string> | null
	): GeminiQuotaBucket[] {
		return normalizeGeminiQuotaBuckets(buckets, allowedModelIds);
	}

	private humanizeModelLabel(modelId: string): string {
		return humanizeGeminiModelLabel(modelId);
	}

	private async getGeminiBinaryPath(): Promise<string | null> {
		if (this.geminiBinaryPathResolved) {
			return this.geminiBinaryPath;
		}

		this.geminiBinaryPathResolved = true;

		try {
			const { stdout } = await this.deps.exec('which gemini');
			const binaryPath = stdout.trim();
			if (!binaryPath) {
				return null;
			}

			this.geminiBinaryPath = await this.deps.realpath(binaryPath);
			return this.geminiBinaryPath;
		} catch {
			this.geminiBinaryPath = null;
			return null;
		}
	}

	private async getSelectedAuthType(): Promise<string | null> {
		const settings = await this.deps.readJsonFile<GeminiSettings>(this.settingsFile);
		return settings?.security?.auth?.selectedType || null;
	}

	private async getStoredCredentials(): Promise<GoogleOAuthCredentials | null> {
		const keychainCredentials = await this.readCredentialsFromKeychain();
		if (keychainCredentials) {
			return keychainCredentials;
		}

		return this.readCredentialsFromFile();
	}

	private async readCredentialsFromKeychain(): Promise<GoogleOAuthCredentials | null> {
		if (this.deps.platform !== 'darwin') {
			return null;
		}

		try {
			const { stdout } = await this.deps.exec(
				`security find-generic-password -s "${GEMINI_OAUTH_SERVICE}" -a "${GEMINI_OAUTH_ACCOUNT}" -w 2>/dev/null`
			);
			const raw = stdout.trim();
			if (!raw) {
				return null;
			}

			const parsed = JSON.parse(raw) as KeychainCredentialEnvelope;
			if (!parsed.token?.accessToken) {
				return null;
			}

			return {
				access_token: parsed.token.accessToken,
				refresh_token: parsed.token.refreshToken,
				token_type: parsed.token.tokenType,
				scope: parsed.token.scope,
				expiry_date: parsed.token.expiresAt,
			};
		} catch {
			return null;
		}
	}

	private async readCredentialsFromFile(): Promise<GoogleOAuthCredentials | null> {
		return this.deps.readJsonFile<GoogleOAuthCredentials>(this.credentialsFile);
	}

	private async getAccessToken(): Promise<string | null> {
		const credentials = await this.getStoredCredentials();
		if (!credentials) {
			return null;
		}

		if (credentials.access_token && !this.isExpired(credentials.expiry_date)) {
			return credentials.access_token;
		}

		if (!credentials.refresh_token) {
			return credentials.access_token || null;
		}

		return this.refreshAccessToken(credentials.refresh_token);
	}

	private isExpired(expiryDate?: number): boolean {
		if (!expiryDate) {
			return false;
		}

		return this.deps.now() >= expiryDate - 60_000;
	}

	private async refreshAccessToken(refreshToken: string): Promise<string | null> {
		try {
			const response = await this.deps.fetch('https://oauth2.googleapis.com/token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams({
					client_id: GOOGLE_OAUTH_CLIENT_ID,
					client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
				}).toString(),
				signal: AbortSignal.timeout(10_000),
			});

			if (!response.ok) {
				const text = await response.text().catch(() => '');
				debugWarn(`[Gemini] Token refresh failed (${response.status}): ${text.slice(0, 300)}`);
				return null;
			}

			const data = await response.json() as { access_token?: string };
			return data.access_token || null;
		} catch (error) {
			debugWarn('[Gemini] Token refresh error:', error);
			return null;
		}
	}

	private async getQuotaResponse(): Promise<RetrieveUserQuotaResponse | null> {
		const cachedQuotaResponse = getCachedValue(this.cachedQuotaResponse, this.cacheExpiry, this.deps.now());
		if (cachedQuotaResponse) {
			return cachedQuotaResponse;
		}

		return withStaleFallback(async () => {
			const authType = await this.getSelectedAuthType();
			if (authType !== 'oauth-personal') {
				return null;
			}

			const accessToken = await this.getAccessToken();
			if (!accessToken) {
				return this.cachedQuotaResponse;
			}

			const projectId = await this.resolveProjectId(accessToken);
			if (!projectId) {
				return this.cachedQuotaResponse;
			}

			const quotaResponse = await this.fetchUserQuota(accessToken, projectId);
			this.cachedQuotaResponse = quotaResponse;
			this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
			return quotaResponse;
		}, this.cachedQuotaResponse, (error) => {
			console.error('[Gemini] Failed to fetch usage:', error);
		});
	}

	private async resolveProjectId(accessToken: string): Promise<string | null> {
		const configuredProject = this.deps.env['GOOGLE_CLOUD_PROJECT'] || this.deps.env['GOOGLE_CLOUD_PROJECT_ID'];
		const body: Record<string, unknown> = {
			metadata: {
				ideType: 'IDE_UNSPECIFIED',
				platform: 'PLATFORM_UNSPECIFIED',
				pluginType: 'GEMINI',
			},
		};

		if (configuredProject) {
			body.cloudaicompanionProject = configuredProject;
			(body.metadata as Record<string, string>).duetProject = configuredProject;
		}

		const response = await this.postJson<LoadCodeAssistResponse>('loadCodeAssist', accessToken, body);

		if (!response.currentTier?.id) {
			debugLog('[Gemini] Account is not onboarded yet. Open Gemini CLI once and finish setup.');
			return null;
		}

		return response.cloudaicompanionProject || configuredProject || null;
	}

	private async fetchUserQuota(accessToken: string, projectId: string): Promise<RetrieveUserQuotaResponse> {
		return this.postJson<RetrieveUserQuotaResponse>('retrieveUserQuota', accessToken, {
			project: projectId,
		});
	}

	private async postJson<T>(method: string, accessToken: string, body: unknown): Promise<T> {
		const response = await this.deps.fetch(`${this.CODE_ASSIST_ENDPOINT}:${method}`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				'User-Agent': 'mana.bar',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`${method} failed (${response.status}): ${text.slice(0, 300)}`);
		}

		return response.json() as Promise<T>;
	}

	getNow(): number {
		return this.deps.now();
	}
}

class GeminiModelProvider extends UsageProvider {
	readonly serviceId = 'gemini' as const;
	private readonly serviceName: string;

	constructor(
		private readonly modelId: string,
		private readonly parent: GeminiProvider,
	) {
		super();
		this.serviceName = parent.getServiceNameForModel(modelId);
	}

	getServiceName(): string {
		return this.serviceName;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<UsageData | null> {
		try {
			const bucket = await this.parent.getQuotaBucketForModel(this.modelId);
			if (!bucket) {
				return null;
			}

			const modelUsage = this.parent.toModelUsage(bucket);
			if (!modelUsage) {
				return null;
			}

			return {
				serviceId: this.serviceId,
				serviceName: this.serviceName,
				totalUsed: modelUsage.used,
				totalLimit: modelUsage.limit,
				resetTime: modelUsage.resetTime,
				models: [modelUsage],
				lastUpdated: new Date(this.parent.getNow()),
			};
		} catch (error) {
			console.error(`[${this.serviceName}] Failed to fetch usage:`, error);
			return null;
		}
	}

	async getModels(): Promise<string[]> {
		return [this.modelId];
	}
}
