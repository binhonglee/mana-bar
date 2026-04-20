import { UsageProvider } from './base';
import { ServiceHealth, UsageData } from '../types';
import { fileExists, readJsonFile, joinPath, getHomeDir } from '../utils';
import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AnthropicUsageResponse, parseClaudeUsageResponse } from './claude-code-parse';
import { getCacheExpiry, getCachedValue, withStaleFallback } from './cache';
import { debugLog } from '../logger';

const execAsync = promisify(exec);

/**
 * Credentials structure from ~/.claude/.credentials.json
 */
interface ClaudeCredentials {
	claudeAiOauth?: {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
	};
}

interface ClaudeHttpResponse {
	statusCode?: number;
	body: string;
}

export interface ClaudeCodeProviderDeps {
	now?: () => number;
	platform?: NodeJS.Platform;
	homeDir?: string;
	fileExists?: (filePath: string) => Promise<boolean>;
	readJsonFile?: <T>(filePath: string) => Promise<T | null>;
	exec?: (command: string) => Promise<{ stdout: string; stderr?: string }>;
	request?: (options: https.RequestOptions) => Promise<ClaudeHttpResponse>;
}

function defaultClaudeRequest(options: https.RequestOptions): Promise<ClaudeHttpResponse> {
	return new Promise((resolve, reject) => {
		const req = https.request(options, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				resolve({
					statusCode: res.statusCode,
					body: data,
				});
			});
		});

		req.on('error', (error) => {
			reject(error);
		});

		req.on('timeout', () => {
			req.destroy();
			reject(new Error('Request timeout'));
		});

		req.end();
	});
}

/**
 * Provider for Claude Code usage tracking
 *
 * Uses Anthropic OAuth usage API endpoint to fetch quota information.
 * This endpoint is read-only and does NOT count against user quota.
 *
 * Implementation based on ccstatusline:
 * - API: https://api.anthropic.com/api/oauth/usage
 * - Auth: OAuth bearer token from keychain (macOS) or .credentials.json
 * - Cache: 180 seconds to avoid API hammering
 */
export class ClaudeCodeProvider extends UsageProvider {
	readonly serviceId = 'claudeCode' as const;
	private readonly CACHE_TTL = 180 * 1000; // 3 minutes
	private readonly claudeDir: string;
	private readonly credentialsFile: string;
	private readonly deps: Required<ClaudeCodeProviderDeps>;

	private cachedData: UsageData | null = null;
	private cacheExpiry: number = 0;
	private lastHealth: ServiceHealth | null = null;

	constructor(deps: ClaudeCodeProviderDeps = {}) {
		super();
		this.deps = {
			now: deps.now ?? Date.now,
			platform: deps.platform ?? process.platform,
			homeDir: deps.homeDir ?? getHomeDir(),
			fileExists: deps.fileExists ?? fileExists,
			readJsonFile: deps.readJsonFile ?? readJsonFile,
			exec: deps.exec ?? execAsync,
			request: deps.request ?? defaultClaudeRequest,
		};
		this.claudeDir = joinPath(this.deps.homeDir, '.claude');
		this.credentialsFile = joinPath(this.claudeDir, '.credentials.json');
	}

	getServiceName(): string {
		return 'Claude Code';
	}

	async isAvailable(): Promise<boolean> {
		// Check if ~/.claude directory exists and we can get auth token
		if (!await this.deps.fileExists(this.claudeDir)) {
			return false;
		}

		try {
			const token = await this.getAuthToken();
			return token !== null;
		} catch {
			return false;
		}
	}

	async getUsage(): Promise<UsageData | null> {
		const cachedData = getCachedValue(this.cachedData, this.cacheExpiry, this.deps.now());
		if (cachedData) {
			debugLog('[ClaudeCode] Returning cached data');
			return cachedData;
		}

		return withStaleFallback(async () => {
			const token = await this.getAuthToken();
			debugLog('[ClaudeCode] Got auth token:', token ? `${token.substring(0, 10)}...` : 'null');
			if (!token) {
				debugLog('[ClaudeCode] No auth token, returning null');
				return null;
			}

			const usageData = await this.fetchUsageFromAPI(token);
			debugLog('[ClaudeCode] Fetched usage data:', usageData);
			if (usageData) {
				this.lastHealth = null;
				this.cachedData = usageData;
				this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
			}

			return usageData;
		}, this.cachedData, (error) => {
			console.error('[ClaudeCode] Failed to fetch usage:', error);
		});
	}

	override getLastServiceHealth(): ServiceHealth | null {
		return this.lastHealth;
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	/**
	 * Get OAuth access token from keychain (macOS) or .credentials.json
	 */
	private async getAuthToken(): Promise<string | null> {
		// Try macOS keychain first
		if (this.deps.platform === 'darwin') {
			try {
				const { stdout } = await this.deps.exec(
					'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null'
				);
				const keychainData = JSON.parse(stdout.trim());
				if (keychainData?.claudeAiOauth?.accessToken) {
					return keychainData.claudeAiOauth.accessToken;
				}
			} catch {
				// Fall through to file-based credentials
			}
		}

		// Try .credentials.json
		const credentials = await this.deps.readJsonFile<ClaudeCredentials>(this.credentialsFile);
		return credentials?.claudeAiOauth?.accessToken || null;
	}

	/**
	 * Fetch usage data from Anthropic OAuth API
	 */
	private async fetchUsageFromAPI(token: string): Promise<UsageData | null> {
		debugLog('[ClaudeCode] fetchUsageFromAPI called');
		const response = await this.deps.request({
			hostname: 'api.anthropic.com',
			path: '/api/oauth/usage',
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${token}`,
				'anthropic-beta': 'oauth-2025-04-20'
			},
			timeout: 5000
		});

		if (response.statusCode === 200) {
			try {
				return this.parseUsageResponse(JSON.parse(response.body) as AnthropicUsageResponse);
			} catch (error) {
				throw new Error(`Failed to parse response: ${error}`);
			}
		}

		if (response.statusCode === 429) {
			// Rate limited - surface health state, impose a hard cooldown, and return cached data
			this.lastHealth = {
				kind: 'rateLimited',
				summary: 'Claude Code is rate limited.',
				detail: 'The Anthropic API has temporarily limited requests. Usage data may be stale.',
				lastUpdated: new Date(this.deps.now()),
			};
			this.cacheExpiry = getCacheExpiry(this.deps.now(), 120 * 1000);
			return this.cachedData;
		}

		throw new Error(`API returned status ${response.statusCode}`);
	}

	/**
	 * Parse Anthropic API response into our UsageData format
	 */
	private parseUsageResponse(response: AnthropicUsageResponse): UsageData {
		return parseClaudeUsageResponse(response, this.getServiceName(), new Date(this.deps.now()));
	}
}
