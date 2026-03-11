import { UsageProvider } from './base';
import { UsageData } from '../types';
import { fileExists, readJsonFile, joinPath, getHomeDir } from '../utils';
import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AnthropicUsageResponse, parseClaudeUsageResponse } from './claude-code-parse';

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
	private readonly CLAUDE_DIR = joinPath(getHomeDir(), '.claude');
	private readonly CREDENTIALS_FILE = joinPath(this.CLAUDE_DIR, '.credentials.json');
	private readonly CACHE_TTL = 180 * 1000; // 3 minutes

	private cachedData: UsageData | null = null;
	private cacheExpiry: number = 0;

	getServiceName(): string {
		return 'Claude Code';
	}

	async isAvailable(): Promise<boolean> {
		// Check if ~/.claude directory exists and we can get auth token
		if (!await fileExists(this.CLAUDE_DIR)) {
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
		// Return cached data if still valid
		if (this.cachedData && Date.now() < this.cacheExpiry) {
			console.log('[ClaudeCode] Returning cached data');
			return this.cachedData;
		}

		try {
			const token = await this.getAuthToken();
			console.log('[ClaudeCode] Got auth token:', token ? `${token.substring(0, 10)}...` : 'null');
			if (!token) {
				console.log('[ClaudeCode] No auth token, returning null');
				return null;
			}

			const usageData = await this.fetchUsageFromAPI(token);
			console.log('[ClaudeCode] Fetched usage data:', usageData);
			if (usageData) {
				this.cachedData = usageData;
				this.cacheExpiry = Date.now() + this.CACHE_TTL;
			}

			return usageData;
		} catch (error) {
			console.error('[ClaudeCode] Failed to fetch usage:', error);
			return this.cachedData; // Return stale cache on error
		}
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	/**
	 * Get OAuth access token from keychain (macOS) or .credentials.json
	 */
	private async getAuthToken(): Promise<string | null> {
		// Try macOS keychain first
		if (process.platform === 'darwin') {
			try {
				const { stdout } = await execAsync(
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
		const credentials = await readJsonFile<ClaudeCredentials>(this.CREDENTIALS_FILE);
		return credentials?.claudeAiOauth?.accessToken || null;
	}

	/**
	 * Fetch usage data from Anthropic OAuth API
	 */
	private async fetchUsageFromAPI(token: string): Promise<UsageData | null> {
		console.log('[ClaudeCode] fetchUsageFromAPI called');
		return new Promise((resolve, reject) => {
			const options: https.RequestOptions = {
				hostname: 'api.anthropic.com',
				path: '/api/oauth/usage',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					'anthropic-beta': 'oauth-2025-04-20'
				},
				timeout: 5000
			};

			const req = https.request(options, (res) => {
				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					if (res.statusCode === 200) {
						try {
							const response: AnthropicUsageResponse = JSON.parse(data);
							resolve(this.parseUsageResponse(response));
						} catch (error) {
							reject(new Error(`Failed to parse response: ${error}`));
						}
					} else if (res.statusCode === 429) {
						// Rate limited - return cached data
						resolve(this.cachedData);
					} else {
						reject(new Error(`API returned status ${res.statusCode}`));
					}
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
	 * Parse Anthropic API response into our UsageData format
	 */
	private parseUsageResponse(response: AnthropicUsageResponse): UsageData {
		return parseClaudeUsageResponse(response, this.getServiceName(), new Date());
	}
}
