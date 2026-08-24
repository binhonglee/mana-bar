import * as os from 'os';
import * as path from 'path';
import { ServiceHealth, UsageData } from '../types';
import { UsageProvider } from './base';
import { getCacheExpiry, getCachedValue, withStaleFallback } from './cache';
import { readJsonFile } from '../utils';
import { findBlockedWindow, OpenCodeGoUsageResponse, parseOpenCodeGoUsageResponse } from './opencode-go-parse';

interface OpenCodeGoProviderDeps {
	now?: () => number;
	fetch?: typeof fetch;
	readJsonFile?: <T>(filePath: string) => Promise<T | null>;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * OpenCode stores credentials for each provider in a single auth.json file.
 * The OpenCode Go plan uses the "opencode-go" entry with an API key.
 */
interface OpenCodeAuthFile {
	[provider: string]: { type?: string; key?: string } | undefined;
}

const AUTH_ENTRY = 'opencode-go';

export class OpenCodeGoProvider extends UsageProvider {
	readonly serviceId = 'opencodeGo' as const;
	private readonly CACHE_TTL = 3 * 60 * 1000;
	private readonly RATE_LIMIT_COOLDOWN = 2 * 60 * 1000;
	private readonly MAX_RATE_LIMIT_COOLDOWN = 60 * 60 * 1000;
	private readonly USAGE_PATH = '/usage';
	private readonly deps: Required<OpenCodeGoProviderDeps>;
	private cachedData: UsageData | null = null;
	private cacheExpiry = 0;
	private rateLimitExpiry = 0;
	private lastHealth: ServiceHealth | null = null;

	constructor(deps: OpenCodeGoProviderDeps = {}) {
		super();
		this.deps = {
			now: deps.now ?? Date.now,
			fetch: deps.fetch ?? fetch,
			readJsonFile: deps.readJsonFile ?? readJsonFile,
			homeDir: deps.homeDir ?? os.homedir(),
			env: deps.env ?? process.env,
		};
	}

	getServiceName(): string {
		return 'OpenCode Go';
	}

	async isAvailable(): Promise<boolean> {
		const apiKey = await this.loadApiKey();
		return apiKey !== null;
	}

	async getUsage(): Promise<UsageData | null> {
		const now = this.deps.now();
		const cachedData = getCachedValue(this.cachedData, this.cacheExpiry, now);
		if (cachedData) {
			return cachedData;
		}

		// Honor a rate-limit cooldown so repeated refreshes do not hammer the
		// endpoint every poll. The rate-limited health set at the 429 stays in
		// place, and the last known usage remains visible.
		if (now < this.rateLimitExpiry) {
			return this.cachedData;
		}

		return withStaleFallback(async () => {
			const apiKey = await this.loadApiKey();
			if (!apiKey) {
				this.cachedData = null;
				this.cacheExpiry = 0;
				this.lastHealth = null;
				return null;
			}

			const usageResponse = await this.fetchUsage(apiKey);
			if (!usageResponse) {
				// The fetch set a health state (reauth, rate limited, or
				// unavailable). Keep the last known usage visible if we have it.
				return this.cachedData;
			}

			const usageData = parseOpenCodeGoUsageResponse(
				usageResponse,
				this.getServiceName(),
				new Date(this.deps.now())
			);

			if (!usageData.quotaWindows) {
				// A 200 response with no recognizable windows is more likely a
				// malformed payload than real "zero usage". Do not show a healthy
				// 0% card for it. Report the service as unavailable instead.
				this.lastHealth = {
					kind: 'unavailable',
					summary: 'OpenCode Go returned no usage data.',
					detail: 'The usage response did not contain any quota windows. Usage data may be stale.',
					lastUpdated: new Date(this.deps.now()),
				};
				return this.cachedData;
			}

			const blockedWindow = findBlockedWindow(usageResponse);
			this.lastHealth = blockedWindow
				? {
					kind: 'rateLimited',
					summary: `OpenCode Go ${blockedWindow.label} limit reached.`,
					detail: `The ${blockedWindow.label} window reports status "${blockedWindow.status}".`,
					lastUpdated: new Date(this.deps.now()),
				}
				: null;
			this.rateLimitExpiry = 0;
			this.cachedData = usageData;
			this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
			return usageData;
		}, this.cachedData, (error) => {
			// Network errors, request timeouts, malformed JSON, and unexpected
			// HTTP statuses land here. Surface them as an unavailable health state
			// so the service stays visible instead of silently disappearing.
			console.error('Failed to fetch OpenCode Go usage:', error);
			this.lastHealth = {
				kind: 'unavailable',
				summary: 'OpenCode Go usage request failed.',
				detail: `${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
				lastUpdated: new Date(this.deps.now()),
			};
		});
	}

	override clearCache(): void {
		// Expire the cache so the next getUsage() re-fetches, but keep the last
		// usage as the stale fallback and keep the rate-limit cooldown. The
		// UsageManager calls this before every refresh, so dropping cachedData
		// here would defeat the stale fallback on the polling path.
		this.cacheExpiry = 0;
	}

	override getLastServiceHealth(): ServiceHealth | null {
		return this.lastHealth;
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	private getApiBaseUrl(): string {
		const raw = this.deps.env.MANA_BAR_OPENCODE_GO_API_BASE?.trim();
		if (!raw) {
			return 'https://opencode.ai/zen/go/v1';
		}
		return raw.endsWith('/') ? raw.slice(0, -1) : raw;
	}

	private async fetchUsage(apiKey: string): Promise<OpenCodeGoUsageResponse | null> {
		const response = await this.deps.fetch(`${this.getApiBaseUrl()}${this.USAGE_PATH}`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'application/json',
			},
			// Never follow a redirect: it could send the bearer token to another host.
			redirect: 'error',
			signal: AbortSignal.timeout(10_000),
		});

		if (response.status === 401 || response.status === 403) {
			this.lastHealth = {
				kind: 'reauthRequired',
				summary: 'OpenCode Go needs a new login.',
				detail: 'The stored API key was rejected. Run "opencode auth login" to refresh it.',
				lastUpdated: new Date(this.deps.now()),
			};
			return null;
		}

		if (response.status === 429) {
			const cooldown = this.parseRetryAfter(response.headers.get('retry-after')) ?? this.RATE_LIMIT_COOLDOWN;
			this.rateLimitExpiry = this.deps.now() + cooldown;
			this.lastHealth = {
				kind: 'rateLimited',
				summary: 'OpenCode Go is rate limited (429).',
				detail: 'The OpenCode API temporarily limited requests. Usage data may be stale.',
				lastUpdated: new Date(this.deps.now()),
			};
			return null;
		}

		if (response.status >= 500) {
			this.lastHealth = {
				kind: 'unavailable',
				summary: `OpenCode Go is unavailable (${response.status}).`,
				detail: 'The OpenCode API returned a server error. Usage data may be stale.',
				lastUpdated: new Date(this.deps.now()),
			};
			return null;
		}

		if (!response.ok) {
			// Any other non-OK status (for example 400 or 404) is unexpected. Throw
			// so the getUsage error handler records an unavailable health state.
			const details = await response.text().catch(() => '');
			throw new Error(`OpenCode Go API request failed (${response.status}): ${details.slice(0, 200)}`);
		}

		return await response.json() as OpenCodeGoUsageResponse;
	}

	/**
	 * Parse a Retry-After header into a cooldown in milliseconds. The header can
	 * be a number of seconds or an HTTP date. Returns null when it is absent or
	 * cannot be parsed. The result is clamped to a sane range so a hostile or
	 * malformed value cannot freeze the provider until the next reload.
	 */
	private parseRetryAfter(headerValue: string | null): number | null {
		if (!headerValue) {
			return null;
		}

		const trimmed = headerValue.trim();
		const seconds = Number(trimmed);
		if (trimmed !== '' && Number.isFinite(seconds)) {
			return this.clampCooldown(seconds * 1000);
		}

		const dateMs = Date.parse(trimmed);
		if (!Number.isNaN(dateMs)) {
			return this.clampCooldown(dateMs - this.deps.now());
		}

		return null;
	}

	private clampCooldown(milliseconds: number): number {
		return Math.min(this.MAX_RATE_LIMIT_COOLDOWN, Math.max(0, milliseconds));
	}

	/**
	 * Load the OpenCode Go API key. An explicit environment variable wins so
	 * users can override the source. Otherwise read the key from the OpenCode
	 * auth.json file, but only from an "api" type entry.
	 */
	private async loadApiKey(): Promise<string | null> {
		const envKey = this.deps.env.MANA_BAR_OPENCODE_GO_API_KEY?.trim();
		if (envKey) {
			return envKey;
		}

		const authFile = await this.deps.readJsonFile<OpenCodeAuthFile>(this.getAuthFilePath());
		const entry = authFile?.[AUTH_ENTRY];
		if (entry?.type !== 'api' || typeof entry.key !== 'string') {
			return null;
		}
		return entry.key.trim() || null;
	}

	/**
	 * Path to the OpenCode auth.json file. This matches how OpenCode itself
	 * resolves the path on every platform: it uses XDG_DATA_HOME when set, and
	 * otherwise ~/.local/share. OpenCode applies the same rule on Windows, so no
	 * platform-specific branch is needed.
	 */
	private getAuthFilePath(): string {
		const dataHome = this.deps.env.XDG_DATA_HOME?.trim() || path.join(this.deps.homeDir, '.local', 'share');
		return path.join(dataHome, 'opencode', 'auth.json');
	}
}
