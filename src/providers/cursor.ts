import { exec as defaultExec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { UsageData } from '../types';
import { UsageProvider } from './base';
import { getCacheExpiry, getCachedValue, withStaleFallback } from './cache';
import {
	CursorCurrentPeriodUsageResponse,
	CursorPricingResponse,
	parseCursorUsageResponse,
} from './cursor-parse';

const execAsync = promisify(defaultExec);

interface CursorProviderDeps {
	now?: () => number;
	fetch?: typeof fetch;
	exec?: (command: string) => Promise<{ stdout: string; stderr?: string }>;
	homeDir?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

interface CursorAuthState {
	accessToken: string;
}

export class CursorProvider extends UsageProvider {
	readonly serviceId = 'cursor' as const;
	private readonly CACHE_TTL = 3 * 60 * 1000;
	private readonly USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
	private readonly PRICING_PATH = '/aiserver.v1.DashboardService/IsOnNewPricing';
	private readonly deps: Required<CursorProviderDeps>;
	private cachedData: UsageData | null = null;
	private cacheExpiry = 0;

	constructor(deps: CursorProviderDeps = {}) {
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
		return 'Cursor';
	}

	async isAvailable(): Promise<boolean> {
		const authState = await this.loadAuthState();
		return authState !== null;
	}

	async getUsage(): Promise<UsageData | null> {
		const cachedData = getCachedValue(this.cachedData, this.cacheExpiry, this.deps.now());
		if (cachedData) {
			return cachedData;
		}

		return withStaleFallback(async () => {
			const authState = await this.loadAuthState();
			if (!authState) {
				this.cachedData = null;
				this.cacheExpiry = 0;
				return null;
			}

			const [usageResponse, pricingResponse] = await Promise.all([
				this.fetchJson<CursorCurrentPeriodUsageResponse>(
					this.USAGE_PATH,
					authState.accessToken
				),
				this.fetchJson<CursorPricingResponse>(
					this.PRICING_PATH,
					authState.accessToken
				).catch(() => null),
			]);

			const usageData = parseCursorUsageResponse(
				usageResponse,
				pricingResponse,
				this.getServiceName(),
				new Date(this.deps.now())
			);

			this.cachedData = usageData;
			this.cacheExpiry = getCacheExpiry(this.deps.now(), this.CACHE_TTL);
			return usageData;
		}, this.cachedData, (error) => {
			console.error('Failed to fetch Cursor usage:', error);
		});
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	private getApiBaseUrl(): string {
		const raw = this.deps.env.MANA_BAR_CURSOR_API_BASE?.trim();
		if (!raw) {
			return 'https://api2.cursor.sh';
		}
		return raw.endsWith('/') ? raw.slice(0, -1) : raw;
	}

	private async fetchJson<T>(pathName: string, accessToken: string): Promise<T> {
		const response = await this.deps.fetch(`${this.getApiBaseUrl()}${pathName}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: '{}',
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			const details = await response.text().catch(() => '');
			throw new Error(`Cursor API request failed (${response.status}): ${details.slice(0, 200)}`);
		}

		return await response.json() as T;
	}

	private async loadAuthState(): Promise<CursorAuthState | null> {
		const envToken = this.deps.env.MANA_BAR_CURSOR_ACCESS_TOKEN?.trim();
		if (envToken) {
			return { accessToken: envToken };
		}

		const dbPath = this.getCursorStateDbPath();
		if (!dbPath) {
			return null;
		}

		const escapedPath = dbPath.replace(/"/g, '\\"');
		const command = `sqlite3 "${escapedPath}" "select value from ItemTable where key='cursorAuth/accessToken' limit 1;"`;
		try {
			const { stdout } = await this.deps.exec(command);
			const accessToken = stdout.trim();
			if (!accessToken) {
				return null;
			}
			return { accessToken };
		} catch {
			return null;
		}
	}

	private getCursorStateDbPath(): string | null {
		if (this.deps.platform === 'darwin') {
			return path.join(
				this.deps.homeDir,
				'Library',
				'Application Support',
				'Cursor',
				'User',
				'globalStorage',
				'state.vscdb'
			);
		}

		if (this.deps.platform === 'win32') {
			const appDataDir = this.deps.env.APPDATA ?? path.join(this.deps.homeDir, 'AppData', 'Roaming');
			return path.join(appDataDir, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
		}

		const configDir = this.deps.env.XDG_CONFIG_HOME ?? path.join(this.deps.homeDir, '.config');
		return path.join(configDir, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
	}
}
