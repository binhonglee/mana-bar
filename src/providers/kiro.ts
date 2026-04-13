import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { UsageProvider } from './base';
import { UsageData } from '../types';
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

	constructor(
		private readonly token: KiroToken,
		private readonly label: string,
		deps: KiroProviderDeps = {}
	) {
		super();
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
			const usageData = await this.fetchUsageLimits();
			if (usageData) {
				this.cachedData = usageData;
				this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
			}
			return usageData;
		}, this.cachedData, (error) => {
			console.error(`[${this.label}] Failed to get usage:`, error);
		});
	}

	async getModels(): Promise<string[]> {
		return [];
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
			return null;
		}

		const data = await response.json() as KiroUsageLimitsResponse;
		const breakdown = data.usageBreakdownList?.[0];
		if (!breakdown) return null;

		const totalUsed = Math.round((breakdown.currentUsageWithPrecision ?? 0) * 10) / 10;
		const totalLimit = Math.round((breakdown.usageLimitWithPrecision ?? 0) * 10) / 10;
		if (totalLimit === 0 && totalUsed === 0) return null;

		const planName = data.subscriptionInfo?.subscriptionTitle;
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

	const seen = new Set<string>();
	const found: Array<{ token: KiroToken; source: string }> = [];

	// Source 1: kiro-cli SQLite DB
	const dbPath = getDbPath(platform, homeDir, env);
	if (dbPath) {
		const escaped = dbPath.replace(/"/g, '\\"');
		try {
			const { stdout } = await execFn(`sqlite3 "${escaped}" "select value from auth_kv where key='kirocli:social:token' limit 1;"`);
			const value = stdout.trim();
			if (value) {
				const token = JSON.parse(value) as KiroToken;
				if (token.access_token) found.push({ token, source: 'CLI' });
			}
		} catch { /* not available */ }
	}

	// Source 2: Kiro IDE (~/.aws/sso/cache/kiro-auth-token.json)
	const ideCredsPath = path.join(homeDir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
	try {
		const { stdout } = await execFn(`cat "${ideCredsPath}"`);
		const parsed = JSON.parse(stdout) as { accessToken?: string; profileArn?: string };
		if (parsed.accessToken) {
			found.push({ token: { access_token: parsed.accessToken, profile_arn: parsed.profileArn }, source: 'IDE' });
		}
	} catch { /* not available */ }

	// Determine labels: "Kiro" if single unique account, "Kiro CLI"/"Kiro IDE" if different accounts
	const uniqueArns = new Set(found.map(f => f.token.profile_arn ?? f.token.access_token.slice(0, 20)));
	const multipleAccounts = uniqueArns.size > 1;

	for (const { token, source } of found) {
		const key = token.profile_arn ?? token.access_token.slice(0, 20);
		if (seen.has(key)) continue;
		seen.add(key);
		const label = multipleAccounts ? `Kiro ${source}` : 'Kiro';
		registerCallback(new KiroProvider(token, label, deps));
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
