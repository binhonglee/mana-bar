import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { UsageProvider } from './base';
import { ServiceHealth, UsageData } from '../types';
import { getCacheExpiry, getCachedValue, withStaleFallback } from './cache';
import { debugLog } from '../logger';

const execAsync = promisify(exec);

export interface KiroProviderDeps {
	now?: () => number;
	fetch?: typeof fetch;
	exec?: (command: string, options?: { timeout?: number }) => Promise<{ stdout: string; stderr?: string }>;
	homeDir?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

interface KiroToken {
	access_token: string;
	profile_arn?: string;
	/** Epoch ms when the access token expires, if known from the source credential store. */
	expires_at_ms?: number;
}

interface KiroUsageLimitsResponse {
	subscriptionInfo?: { subscriptionTitle?: string };
	nextDateReset?: number;
	usageBreakdownList?: Array<{
		currentUsageWithPrecision?: number;
		usageLimitWithPrecision?: number;
	}>;
}

/**
 * Discoverable provider for Kiro usage tracking.
 * Discovers credentials from kiro-cli (SQLite DB) and Kiro IDE (~/.aws/sso/cache).
 * Registers a separate provider instance per unique account found.
 *
 * API: GET https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?profileArn=...
 */
export class KiroProvider extends UsageProvider {
	readonly serviceId = 'kiro' as const;
	private readonly CACHE_TTL = 3 * 60 * 1000;
	private readonly deps: Required<KiroProviderDeps>;
	private cachedData: UsageData | null = null;
	private cacheExpiry = 0;
	private lastHealth: ServiceHealth | null = null;
	private token: KiroToken;

	constructor(
		token: KiroToken,
		private readonly label: string,
		private readonly tokenSource: { kind: 'cli'; dbPath: string } | { kind: 'ide'; filePath: string },
		deps: KiroProviderDeps = {}
	) {
		super();
		this.token = token;
		this.deps = {
			now: deps.now ?? Date.now,
			fetch: deps.fetch ?? fetch,
			exec: deps.exec ?? execAsync,
			homeDir: deps.homeDir ?? os.homedir(),
			platform: deps.platform ?? process.platform,
			env: deps.env ?? process.env,
		};
	}

	getServiceName(): string {
		return this.label;
	}

	async isAvailable(): Promise<boolean> {
		return true; // token already validated during discovery
	}

	async getUsage(): Promise<UsageData | null> {
		const cached = getCachedValue(this.cachedData, this.cacheExpiry, this.deps.now());
		if (cached) return cached;

		return withStaleFallback(async () => {
			// Always re-read token from disk so reauth is picked up immediately
			const token = await this.loadToken();
			if (!token) {
				return null;
			}

			// Fail fast on locally expired tokens: surface a reauth-required state and skip
			// the remote call, since the CodeWhisperer endpoint will just return 401/403.
			// We intentionally do NOT refresh tokens, since the extension is read-only and
			// writing back would risk desyncing the user's CLI / IDE session.
			if (token.expires_at_ms && this.deps.now() >= token.expires_at_ms) {
				this.lastHealth = this.buildReauthHealth('Kiro credentials have expired.');
				return null;
			}

			this.token = token;
			const usageData = await this.fetchUsageLimits();
			if (usageData) {
				this.cachedData = usageData;
				this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
				this.lastHealth = null;
			}
			return usageData;
		}, this.cachedData, (error) => {
			console.error(`[${this.label}] Failed to get usage:`, error);
		});
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	override clearCache(): void {
		this.cachedData = null;
		this.cacheExpiry = 0;
		this.lastHealth = null;
	}

	private async loadToken(): Promise<KiroToken | null> {
		try {
			if (this.tokenSource.kind === 'cli') {
				const escaped = this.tokenSource.dbPath.replace(/"/g, '\\"');
				const { stdout } = await this.deps.exec(`sqlite3 "${escaped}" "select value from auth_kv where key='kirocli:social:token' limit 1;"`);
				const value = stdout.trim();
				if (value) {
					const parsed = JSON.parse(value) as { access_token?: string; profile_arn?: string; expires_at?: string | number };
					if (parsed.access_token) {
						return {
							access_token: parsed.access_token,
							profile_arn: parsed.profile_arn,
							expires_at_ms: parseExpiresAtMs(parsed.expires_at),
						};
					}
				}
			} else {
				const { stdout } = await this.deps.exec(`cat "${this.tokenSource.filePath}"`);
				const parsed = JSON.parse(stdout) as { accessToken?: string; profileArn?: string; expiresAt?: string | number };
				if (parsed.accessToken) {
					return {
						access_token: parsed.accessToken,
						profile_arn: parsed.profileArn,
						expires_at_ms: parseExpiresAtMs(parsed.expiresAt),
					};
				}
			}
		} catch {
			// credential source unavailable
		}
		return null;
	}

	override getLastServiceHealth(): ServiceHealth | null {
		return this.lastHealth;
	}

	private buildReauthHealth(summary: string, detail?: string): ServiceHealth {
		return {
			kind: 'reauthRequired',
			summary,
			detail: detail ?? 'Sign in again in Kiro CLI or Kiro IDE to resume usage tracking.',
			lastUpdated: new Date(this.deps.now()),
		};
	}

	private async fetchUsageLimits(): Promise<UsageData | null> {
		const profileArn = this.token.profile_arn;
		const url = profileArn
			? `https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?profileArn=${encodeURIComponent(profileArn)}`
			: 'https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits';

		const response = await this.deps.fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${this.token.access_token}` },
			signal: AbortSignal.timeout(8000),
		});

		if (!response.ok) {
			debugLog(`[${this.label}] getUsageLimits returned ${response.status}`);
			if (response.status === 401 || response.status === 403) {
				this.lastHealth = this.buildReauthHealth(
					'Kiro credentials were rejected by the usage service.'
				);
			}
			return null;
		}

		const data = await response.json() as KiroUsageLimitsResponse;
		const breakdown = data.usageBreakdownList?.[0];
		if (!breakdown) return null;

		const totalUsed = Math.round((breakdown.currentUsageWithPrecision ?? 0) * 10) / 10;
		const totalLimit = Math.round((breakdown.usageLimitWithPrecision ?? 0) * 10) / 10;
		if (totalLimit === 0 && totalUsed === 0) return null;

		const resetTime = data.nextDateReset ? new Date(data.nextDateReset * 1000) : undefined;

		return {
			serviceId: 'kiro',
			serviceName: this.label,
			totalUsed,
			totalLimit,
			resetTime,
			lastUpdated: new Date(this.deps.now()),
		};
	}
}

/**
 * Discovers all Kiro credential sources and registers a KiroProvider per unique account.
 */
export async function discoverKiroProviders(
	registerCallback: (provider: UsageProvider) => void,
	deps: KiroProviderDeps = {}
): Promise<void> {
	const execFn = deps.exec ?? execAsync;
	const homeDir = deps.homeDir ?? os.homedir();
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;

	const found: Array<{ token: KiroToken; source: string; tokenSource: { kind: 'cli'; dbPath: string } | { kind: 'ide'; filePath: string } }> = [];

	// Source 1: kiro-cli SQLite DB
	const dbPath = getDbPath(platform, homeDir, env);
	if (dbPath) {
		const escaped = dbPath.replace(/"/g, '\\"');
		try {
			const { stdout } = await execFn(`sqlite3 "${escaped}" "select value from auth_kv where key='kirocli:social:token' limit 1;"`);
			const value = stdout.trim();
			if (value) {
				const parsed = JSON.parse(value) as { access_token?: string; profile_arn?: string; expires_at?: string | number };
				if (parsed.access_token) {
					found.push({
						token: {
							access_token: parsed.access_token,
							profile_arn: parsed.profile_arn,
							expires_at_ms: parseExpiresAtMs(parsed.expires_at),
						},
						source: 'CLI',
						tokenSource: { kind: 'cli', dbPath },
					});
				}
			}
		} catch { /* not available */ }
	}

	// Source 2: Kiro IDE (~/.aws/sso/cache/kiro-auth-token.json)
	const ideCredsPath = path.join(homeDir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
	try {
		const { stdout } = await execFn(`cat "${ideCredsPath}"`);
		const parsed = JSON.parse(stdout) as { accessToken?: string; profileArn?: string; expiresAt?: string | number };
		if (parsed.accessToken) {
			found.push({
				token: {
					access_token: parsed.accessToken,
					profile_arn: parsed.profileArn,
					expires_at_ms: parseExpiresAtMs(parsed.expiresAt),
				},
				source: 'IDE',
				tokenSource: { kind: 'ide', filePath: ideCredsPath },
			});
		}
	} catch { /* not available */ }

	// Determine labels: "Kiro" if single unique account, "Kiro CLI"/"Kiro IDE" if different accounts
	const uniqueArns = new Set(found.map(f => f.token.profile_arn ?? f.token.access_token.slice(0, 20)));
	const multipleAccounts = uniqueArns.size > 1;

	// Group by account key; when multiple sources share the same account, pick the
	// freshest token so a valid IDE token wins over an expired CLI token (or vice versa).
	const byKey = new Map<string, Array<{ token: KiroToken; source: string; tokenSource: { kind: 'cli'; dbPath: string } | { kind: 'ide'; filePath: string } }>>();
	for (const entry of found) {
		const key = entry.token.profile_arn ?? entry.token.access_token.slice(0, 20);
		const group = byKey.get(key) ?? [];
		group.push(entry);
		byKey.set(key, group);
	}

	const now = (deps.now ?? Date.now)();
	for (const [, group] of byKey) {
		// Sort: non-expired tokens first, then by latest expiry
		group.sort((a, b) => {
			const aExp = a.token.expires_at_ms ?? Infinity;
			const bExp = b.token.expires_at_ms ?? Infinity;
			const aExpired = aExp !== Infinity && now >= aExp;
			const bExpired = bExp !== Infinity && now >= bExp;
			if (aExpired !== bExpired) return aExpired ? 1 : -1;
			return bExp - aExp;
		});

		const best = group[0];
		const label = multipleAccounts ? `Kiro ${best.source}` : 'Kiro';
		registerCallback(new KiroProvider(best.token, label, best.tokenSource, deps));
	}
}

/**
 * Thin discoverable wrapper used by provider-registration.
 */
export class KiroDiscoverable extends UsageProvider {
	readonly serviceId = 'kiro' as const;
	private readonly deps: KiroProviderDeps;

	constructor(deps: KiroProviderDeps = {}) {
		super();
		this.deps = deps;
	}

	getServiceName(): string { return 'Kiro'; }
	async isAvailable(): Promise<boolean> { return false; }
	async getUsage(): Promise<UsageData | null> { return null; }
	async getModels(): Promise<string[]> { return []; }

	async discoverQuotaGroups(registerCallback: (provider: UsageProvider) => void): Promise<void> {
		await discoverKiroProviders(registerCallback, this.deps);
	}
}

/**
 * Normalize the many shapes an expiry field can take into epoch ms:
 * - Numeric seconds (< 1e12) or milliseconds
 * - ISO 8601 string
 * Returns undefined if the input cannot be parsed.
 */
function parseExpiresAtMs(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

function getDbPath(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): string | null {
	if (platform === 'darwin') {
		return path.join(homeDir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
	}
	if (platform === 'linux') {
		const xdgData = env.XDG_DATA_HOME ?? path.join(homeDir, '.local', 'share');
		return path.join(xdgData, 'kiro-cli', 'data.sqlite3');
	}
	if (platform === 'win32') {
		const appData = env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
		return path.join(appData, 'kiro-cli', 'data.sqlite3');
	}
	return null;
}
