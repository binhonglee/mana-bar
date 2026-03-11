import { execFile as defaultExecFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { QuotaWindowUsage, UsageData } from '../types';
import { UsageProvider } from './base';

const SERVICE_NAME = 'VSCode Copilot';
const CHAT_QUOTA_CONTEXT_KEY = 'github.copilot.chat.quotaExceeded';
const COMPLETIONS_QUOTA_CONTEXT_KEY = 'github.copilot.completions.quotaExceeded';
const COPILOT_DEFAULT_PROVIDER_ID = 'github';
const COPILOT_ENTERPRISE_PROVIDER_ID = 'github-enterprise';
const COPILOT_DEFAULT_ENTITLEMENT_URL = 'https://api.github.com/copilot_internal/user';
const COPILOT_SCOPE_SETS = [
	['user:email'],
	['read:user'],
	['read:user', 'user:email', 'repo', 'workflow'],
] as const;
const COPILOT_ADVANCED_SECTION = 'github.copilot';
const COPILOT_ADVANCED_KEY = 'advanced';
const COPILOT_ENTERPRISE_SECTION = 'github-enterprise';
const COPILOT_ENTERPRISE_URI_KEY = 'uri';
const AUTH_FETCH_TTL = 60 * 1000;
const COPILOT_EXTENSION_IDS = ['GitHub.copilot', 'GitHub.copilot-chat'] as const;
const NORMALIZED_COPILOT_EXTENSION_IDS = new Set(
	COPILOT_EXTENSION_IDS.map(id => id.toLowerCase())
);
const QUOTA_HEADER_PRIORITY = [
	'x-quota-snapshot-premium_interactions',
	'x-quota-snapshot-premium_models',
	'x-quota-snapshot-chat',
] as const;
const SAFE_GETTER_NAMES = new Set([
	'quotaInfo',
	'raw',
	'userInfo',
	'copilotToken',
	'token',
]);

type CopilotSurface = 'chat' | 'completions' | 'premium' | 'unknown';
type CopilotSignalSource = 'auth-entitlement' | 'export-probe' | 'fetch' | 'https';
type CopilotProviderId = typeof COPILOT_DEFAULT_PROVIDER_ID | typeof COPILOT_ENTERPRISE_PROVIDER_ID;
type CopilotQuotaHeaderName = typeof QUOTA_HEADER_PRIORITY[number];
type HttpsModule = typeof import('https');
type HttpsRequest = typeof import('https').request;
type HttpsGet = typeof import('https').get;
type ExecFile = typeof import('child_process').execFile;

const defaultHttpsModule = require('https') as HttpsModule;

interface CopilotQuotaSnapshot {
	quota: number;
	used: number;
	resetDate?: Date;
	quotaWindows?: QuotaWindowUsage[];
	overageEnabled: boolean;
	overageUsed: number;
	unlimited: boolean;
	surface: CopilotSurface;
	source: CopilotSignalSource;
	detail: string;
	observedAt: number;
}

interface CopilotQuotaInfoLike {
	quota?: unknown;
	used?: unknown;
	resetDate?: unknown;
	overageEnabled?: unknown;
	overageUsed?: unknown;
	unlimited?: unknown;
}

interface CopilotQuotaSnapshotBucket {
	entitlement?: unknown;
	remaining?: unknown;
	percent_remaining?: unknown;
	overage_permitted?: unknown;
	overage_count?: unknown;
	unlimited?: unknown;
}

interface CopilotEntitlementResponse {
	access_type_sku?: unknown;
	copilot_plan?: unknown;
	quota_snapshots?: Record<string, CopilotQuotaSnapshotBucket>;
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

type CopilotResolvedBucketName = 'chat' | 'completions' | 'premium_interactions' | 'premium_models';

interface CopilotResolvedQuotaBucket {
	name: CopilotResolvedBucketName;
	quota: number;
	used: number;
	percentRemaining: number;
	overageEnabled: boolean;
	overageUsed: number;
	unlimited: boolean;
}

interface CopilotSessionLike {
	id: string;
	accessToken: string;
	account: {
		id: string;
		label: string;
	};
	scopes: readonly string[];
}

interface CopilotStoredSession {
	id?: unknown;
	accessToken?: unknown;
	account?: {
		id?: unknown;
		label?: unknown;
		displayName?: unknown;
	};
	scopes?: unknown;
}

interface PersistedSecretBuffer {
	type?: unknown;
	data?: unknown;
}

interface ElectronSafeStorageLike {
	decryptString(buffer: Buffer): string;
	isEncryptionAvailable?(): boolean;
}

interface CopilotProviderDeps {
	httpsModule?: HttpsModule;
	now?: () => number;
	vscodeApi?: typeof vscode;
	globalObject?: {
		fetch?: typeof fetch;
	};
	execFile?: ExecFile;
	homeDir?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	readPersistedSecret?: (serviceId: string) => Promise<string | null>;
}

interface ResolvedCopilotProviderDeps {
	httpsModule: HttpsModule;
	now: () => number;
	vscodeApi: typeof vscode;
	globalObject: {
		fetch?: typeof fetch;
	};
	execFile: ExecFile;
	homeDir: string;
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	readPersistedSecret: ((serviceId: string) => Promise<string | null>) | null;
}

type HeaderValue = string | string[] | undefined;
type HeadersLike = Headers | Record<string, HeaderValue>;
type NodeRequestLike = {
	on(event: 'response', listener: (response: { headers?: Record<string, HeaderValue> }) => void): unknown;
};

export class CopilotProvider extends UsageProvider {
	private readonly deps: ResolvedCopilotProviderDeps;
	private initialized = false;
	private currentSnapshot: CopilotQuotaSnapshot | null = null;
	private loggedSignalSources = new Set<string>();
	private loggedParseFailures = new Set<string>();
	private loggedExtensionSummaries = new Map<string, string>();
	private loggedDerivedSummaries = new Map<string, string>();
	private loggedDiscoverySummary: string | null = null;
	private loggedAuthSessionSummary: string | null = null;
	private loggedAuthEntitlementSummary: string | null = null;
	private loggedAuthNoSessionSummary: string | null = null;
	private authAccessRequestSummary: string | null = null;
	private waitingForSignalLogged = false;
	private exportProbePromise: Promise<void> | null = null;
	private authFetchPromise: Promise<void> | null = null;
	private authFetchExpiry = 0;
	private chatQuotaExceeded: boolean | null = null;
	private completionsQuotaExceeded: boolean | null = null;
	private originalExecuteCommand?: typeof vscode.commands.executeCommand;
	private originalFetch?: typeof fetch;
	private originalHttpsRequest?: HttpsRequest;
	private originalHttpsGet?: HttpsGet;
	private authChangeDisposable?: vscode.Disposable;
	private extensionsChangeDisposable?: vscode.Disposable;
	private persistedStateDbPath: string | null | undefined;
	private loggedPersistedSessionSummary: string | null = null;
	private loggedPersistedStorageSummary: string | null = null;

	constructor(deps: CopilotProviderDeps = {}) {
		super();
		this.deps = {
			httpsModule: deps.httpsModule ?? defaultHttpsModule,
			now: deps.now ?? Date.now,
			vscodeApi: deps.vscodeApi ?? vscode,
			globalObject: deps.globalObject ?? globalThis,
			execFile: deps.execFile ?? defaultExecFile,
			homeDir: deps.homeDir ?? os.homedir(),
			platform: deps.platform ?? process.platform,
			env: deps.env ?? process.env,
			readPersistedSecret: deps.readPersistedSecret ?? null,
		};
	}

	getServiceName(): string {
		return SERVICE_NAME;
	}

	async isAvailable(): Promise<boolean> {
		const installedExtensions = this.getInstalledExtensions();
		const providerId = this.getPreferredProviderId();
		const hasPersistedSession = installedExtensions.length === 0
			? await this.hasPersistedSession(providerId)
			: false;
		if (installedExtensions.length === 0 && !hasPersistedSession) {
			return false;
		}

		await this.ensureInitialized();
		return true;
	}

	async getUsage(): Promise<UsageData | null> {
		if (!await this.isAvailable()) {
			return null;
		}

		await this.refreshFromAuthentication('poll');

		if (!this.currentSnapshot) {
			await this.runExportProbe('poll');
		}

		if (!this.currentSnapshot) {
			if (!this.waitingForSignalLogged) {
				this.waitingForSignalLogged = true;
				console.log(
					`[Copilot] Waiting for first numeric quota signal from VSCode Copilot (chatQuotaExceeded=${this.chatQuotaExceeded}, completionsQuotaExceeded=${this.completionsQuotaExceeded})`
				);
			}
			return null;
		}

		if (this.currentSnapshot.unlimited || this.currentSnapshot.quota <= 0) {
			return null;
		}

		return {
			serviceName: SERVICE_NAME,
			totalUsed: Math.max(0, Math.round(this.currentSnapshot.used)),
			totalLimit: Math.round(this.currentSnapshot.quota),
			resetTime: this.currentSnapshot.resetDate,
			quotaWindows: this.currentSnapshot.quotaWindows,
			lastUpdated: new Date(this.currentSnapshot.observedAt),
		};
	}

	async getModels(): Promise<string[]> {
		return [];
	}

	dispose(): void {
		this.authChangeDisposable?.dispose();
		this.extensionsChangeDisposable?.dispose();

		if (this.originalExecuteCommand) {
			this.deps.vscodeApi.commands.executeCommand = this.originalExecuteCommand;
		}

		if (this.originalFetch) {
			this.deps.globalObject.fetch = this.originalFetch;
		}

		if (this.originalHttpsRequest) {
			this.deps.httpsModule.request = this.originalHttpsRequest;
		}

		if (this.originalHttpsGet) {
			this.deps.httpsModule.get = this.originalHttpsGet;
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}

		this.initialized = true;
		console.log('[Copilot] Initializing VSCode Copilot provider');

		this.patchCommandExecution();
		this.patchFetch();
		this.patchHttps();
		this.authChangeDisposable = this.deps.vscodeApi.authentication.onDidChangeSessions((event) => {
			if (event.provider.id !== COPILOT_DEFAULT_PROVIDER_ID && event.provider.id !== COPILOT_ENTERPRISE_PROVIDER_ID) {
				return;
			}

			console.log(`[Copilot Auth] Authentication sessions changed for ${event.provider.id}`);
			this.authFetchExpiry = 0;
			this.waitingForSignalLogged = false;
			void this.refreshFromAuthentication('auth-change', true);
		});
		this.extensionsChangeDisposable = this.deps.vscodeApi.extensions.onDidChange(() => {
			console.log('[Copilot Probe] VS Code extensions changed, re-running Copilot probe');
			this.waitingForSignalLogged = false;
			void this.runExportProbe('extension-change');
		});

		await this.runExportProbe('initial');
	}

	private async runExportProbe(reason: string): Promise<void> {
		if (this.exportProbePromise) {
			return this.exportProbePromise;
		}

		this.exportProbePromise = this.performExportProbe(reason).finally(() => {
			this.exportProbePromise = null;
		});

		return this.exportProbePromise;
	}

	private async performExportProbe(reason: string): Promise<void> {
		for (const extension of this.getInstalledExtensions()) {
			const extensionId = extension.id;
			const surface = this.classifySurfaceFromExtensionId(extensionId);
			try {
				const activatedExports = extension.isActive ? extension.exports : await extension.activate();
				const exportValue = extension.exports ?? activatedExports;
				const summary = this.describeExportValue(exportValue);
				if (this.loggedExtensionSummaries.get(extensionId) !== summary) {
					this.loggedExtensionSummaries.set(extensionId, summary);
					console.log(
						`[Copilot Probe] ${reason}: ${extensionId}@${extension.packageJSON?.version ?? 'unknown'} active=${extension.isActive} exports=${summary}`
					);
				}

				this.inspectExportValue(exportValue, `${extensionId}.exports`, surface, 0, new Set());
			} catch (error) {
				console.error(`[Copilot Probe] Failed to inspect ${extensionId}:`, error);
			}
		}
	}

	private async refreshFromAuthentication(reason: string, force = false): Promise<void> {
		if (!force && this.deps.now() < this.authFetchExpiry) {
			return;
		}

		if (this.authFetchPromise) {
			return this.authFetchPromise;
		}

		this.authFetchPromise = this.performAuthFetch(reason).finally(() => {
			this.authFetchExpiry = this.deps.now() + AUTH_FETCH_TTL;
			this.authFetchPromise = null;
		});

		return this.authFetchPromise;
	}

	private async performAuthFetch(reason: string): Promise<void> {
		const fetchImplementation = this.originalFetch ?? this.deps.globalObject.fetch;
		if (typeof fetchImplementation !== 'function') {
			return;
		}

		const providerId = this.getPreferredProviderId();
		const session = await this.findCopilotSession(providerId);
		if (!session) {
			return;
		}

		const sessionSummary = `${providerId}:${session.account.label}:${session.id}:${session.scopes.join(',')}`;
		if (this.loggedAuthSessionSummary !== sessionSummary) {
			this.loggedAuthSessionSummary = sessionSummary;
			console.log(
				`[Copilot Auth] Using ${providerId} session for ${session.account.label} scopes=${session.scopes.join(', ')}`
			);
		}
		this.loggedAuthNoSessionSummary = null;

		const entitlementUrl = this.getEntitlementUrl(providerId);
		try {
			const response = await fetchImplementation(entitlementUrl, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${session.accessToken}`,
					Accept: 'application/json',
				},
				signal: AbortSignal.timeout(10000),
			});

			if (!response.ok) {
				const text = await response.text().catch(() => '');
				this.logParseFailure(
					`auth-fetch:${providerId}:${response.status}:${text.slice(0, 120)}`,
					`[Copilot Auth] ${reason}: entitlement request failed for ${providerId} (${response.status}) ${text.slice(0, 300)}`
				);
				return;
			}

			const payload = await response.json() as unknown;
			const snapshot = this.normalizeAuthEntitlementResponse(payload, entitlementUrl);
			if (snapshot) {
				this.recordSnapshot(snapshot);
			}
		} catch (error) {
			this.logParseFailure(
				`auth-fetch:${providerId}:${String(error)}`,
				`[Copilot Auth] ${reason}: entitlement request failed for ${providerId}: ${String(error)}`
			);
		}
	}

	private getPreferredProviderId(): CopilotProviderId {
		const advancedConfig = this.deps.vscodeApi.workspace
			.getConfiguration(COPILOT_ADVANCED_SECTION)
			.get<{ authProvider?: string } | undefined>(COPILOT_ADVANCED_KEY);

		return advancedConfig?.authProvider === COPILOT_ENTERPRISE_PROVIDER_ID
			? COPILOT_ENTERPRISE_PROVIDER_ID
			: COPILOT_DEFAULT_PROVIDER_ID;
	}

	private getEntitlementUrl(providerId: CopilotProviderId): string {
		if (providerId !== COPILOT_ENTERPRISE_PROVIDER_ID) {
			return COPILOT_DEFAULT_ENTITLEMENT_URL;
		}

		const configuredUri = this.deps.vscodeApi.workspace
			.getConfiguration(COPILOT_ENTERPRISE_SECTION)
			.get<string | undefined>(COPILOT_ENTERPRISE_URI_KEY);

		if (!configuredUri) {
			return COPILOT_DEFAULT_ENTITLEMENT_URL;
		}

		try {
			const uri = new URL(configuredUri);
			return `${uri.protocol}//api.${uri.hostname}${uri.port ? `:${uri.port}` : ''}/copilot_internal/user`;
		} catch (error) {
			this.logParseFailure(
				`enterprise-uri:${configuredUri}`,
				`[Copilot Auth] Invalid GitHub Enterprise URI "${configuredUri}": ${String(error)}`
			);
			return COPILOT_DEFAULT_ENTITLEMENT_URL;
		}
	}

	private async findCopilotSession(providerId: CopilotProviderId): Promise<CopilotSessionLike | null> {
		let accounts: readonly vscode.AuthenticationSessionAccountInformation[] = [];
		try {
			accounts = await this.deps.vscodeApi.authentication.getAccounts(providerId);
		} catch (error) {
			this.logParseFailure(
				`auth-accounts:${providerId}:${String(error)}`,
				`[Copilot Auth] Failed to list accounts for ${providerId}: ${String(error)}`
			);
			return null;
		}

		const tryScopesForAccount = async (
			account?: vscode.AuthenticationSessionAccountInformation
		): Promise<CopilotSessionLike | null> => {
			for (const scopes of COPILOT_SCOPE_SETS) {
				try {
					const session = await this.deps.vscodeApi.authentication.getSession(
						providerId,
						[...scopes],
						{
							silent: true,
							...(account ? { account } : {}),
						}
					);

					if (session) {
						return this.toSessionLike(session);
					}
				} catch (error) {
					this.logParseFailure(
						`auth-session:${providerId}:${account?.id ?? 'default'}:${scopes.join(',')}:${String(error)}`,
						`[Copilot Auth] Failed to get ${providerId} session for ${account?.label ?? 'default account'} (${scopes.join(', ')}): ${String(error)}`
					);
				}
			}

			return null;
		};

		const tryAnySessionForAccount = async (
			account?: vscode.AuthenticationSessionAccountInformation
		): Promise<CopilotSessionLike | null> => {
			try {
				const session = await this.deps.vscodeApi.authentication.getSession(
					providerId,
					[],
					{
						silent: true,
						...(account ? { account } : {}),
					}
				);
				if (session) {
					console.log(
						`[Copilot Auth] Reusing ${providerId} session with fallback scopes=${session.scopes.join(', ')}`
					);
					return this.toSessionLike(session);
				}
			} catch (error) {
				this.logParseFailure(
					`auth-session-any:${providerId}:${account?.id ?? 'default'}:${String(error)}`,
					`[Copilot Auth] Failed to get fallback ${providerId} session for ${account?.label ?? 'default account'}: ${String(error)}`
				);
			}

			return null;
		};

		for (const account of accounts) {
			const session = await tryScopesForAccount(account);
			if (session) {
				return session;
			}

			const fallbackSession = await tryAnySessionForAccount(account);
			if (fallbackSession) {
				return fallbackSession;
			}
		}

		const fallbackSession = await tryScopesForAccount();
		if (fallbackSession) {
			return fallbackSession;
		}

		const anySession = await tryAnySessionForAccount();
		if (anySession) {
			return anySession;
		}

		const persistedSession = await this.findPersistedCopilotSession(providerId);
		if (persistedSession) {
			return persistedSession;
		}

		await this.requestSessionAccess(providerId, accounts);

		const noSessionSummary = `${providerId}:${accounts.map(account => account.label).sort().join(',') || 'none'}`;
		if (this.loggedAuthNoSessionSummary !== noSessionSummary) {
			this.loggedAuthNoSessionSummary = noSessionSummary;
			console.log(
				`[Copilot Auth] No existing ${providerId} session matched Copilot scopes (accounts=${accounts.map(account => account.label).join(', ') || 'none'})`
			);
		}

		return null;
	}

	private toSessionLike(session: vscode.AuthenticationSession): CopilotSessionLike {
		return {
			id: session.id,
			accessToken: session.accessToken,
			account: {
				id: session.account.id,
				label: session.account.label,
			},
			scopes: session.scopes,
		};
	}

	private async hasPersistedSession(providerId: CopilotProviderId): Promise<boolean> {
		const sessions = await this.readPersistedSessions(providerId);
		return sessions.length > 0;
	}

	private async findPersistedCopilotSession(providerId: CopilotProviderId): Promise<CopilotSessionLike | null> {
		const sessions = await this.readPersistedSessions(providerId);
		if (sessions.length === 0) {
			return null;
		}

		for (const scopes of COPILOT_SCOPE_SETS) {
			const matchingSession = sessions.find(session => scopes.every(scope => session.scopes.includes(scope)));
			if (matchingSession) {
				console.log(
					`[Copilot Auth] Reusing persisted ${providerId} session from VS Code secret storage scopes=${matchingSession.scopes.join(', ')}`
				);
				return matchingSession;
			}
		}

		const fallbackSession = sessions[0] ?? null;
		if (fallbackSession) {
			console.log(
				`[Copilot Auth] Reusing persisted ${providerId} session with fallback scopes=${fallbackSession.scopes.join(', ')}`
			);
		}
		return fallbackSession;
	}

	private async readPersistedSessions(providerId: CopilotProviderId): Promise<CopilotSessionLike[]> {
		const serviceId = this.getPersistedSecretServiceId(providerId);
		const rawSecret = await this.readPersistedSecret(serviceId);
		if (!rawSecret) {
			return [];
		}

		try {
			const parsed = JSON.parse(rawSecret) as unknown;
			if (!Array.isArray(parsed)) {
				this.logParseFailure(
					`persisted-session-shape:${providerId}:${typeof parsed}`,
					`[Copilot Auth] Persisted ${providerId} secret did not contain a session array`
				);
				return [];
			}

			const sessions = parsed
				.map(value => this.normalizePersistedSession(value))
				.filter((session): session is CopilotSessionLike => Boolean(session));
			const summary = `${providerId}:${sessions.length}:${sessions.map(session => session.account.label).sort().join(',')}`;
			if (sessions.length > 0 && this.loggedPersistedSessionSummary !== summary) {
				this.loggedPersistedSessionSummary = summary;
				console.log(
					`[Copilot Auth] Loaded ${sessions.length} persisted ${providerId} session(s) from VS Code secret storage`
				);
			}
			return sessions;
		} catch (error) {
			this.logParseFailure(
				`persisted-session-parse:${providerId}:${String(error)}`,
				`[Copilot Auth] Failed to parse persisted ${providerId} sessions: ${String(error)}`
			);
			return [];
		}
	}

	private normalizePersistedSession(value: unknown): CopilotSessionLike | null {
		if (!this.isRecord(value)) {
			return null;
		}

		const session = value as CopilotStoredSession;
		if (typeof session.accessToken !== 'string' || !Array.isArray(session.scopes)) {
			return null;
		}

		const scopes = session.scopes.filter((scope): scope is string => typeof scope === 'string');
		if (scopes.length === 0) {
			return null;
		}

		const account = this.isRecord(session.account) ? session.account : undefined;
		const accountId = typeof account?.id === 'string' || typeof account?.id === 'number'
			? String(account.id)
			: 'persisted';
		const accountLabel = typeof account?.label === 'string'
			? account.label
			: typeof account?.displayName === 'string'
				? account.displayName
				: 'persisted user';

		return {
			id: typeof session.id === 'string' ? session.id : `${accountId}:${scopes.slice().sort().join(' ')}`,
			accessToken: session.accessToken,
			account: {
				id: accountId,
				label: accountLabel,
			},
			scopes,
		};
	}

	private getPersistedSecretServiceId(providerId: CopilotProviderId): string {
		if (providerId !== COPILOT_ENTERPRISE_PROVIDER_ID) {
			return `${providerId}.auth`;
		}

		const configuredUri = this.deps.vscodeApi.workspace
			.getConfiguration(COPILOT_ENTERPRISE_SECTION)
			.get<string | undefined>(COPILOT_ENTERPRISE_URI_KEY);
		if (!configuredUri) {
			return `${providerId}.auth`;
		}

		try {
			const uri = new URL(configuredUri);
			return `${uri.hostname}${uri.pathname}.ghes.auth`;
		} catch {
			return `${providerId}.auth`;
		}
	}

	private async readPersistedSecret(serviceId: string): Promise<string | null> {
		if (this.deps.readPersistedSecret) {
			return this.deps.readPersistedSecret(serviceId);
		}

		const stateDbPath = await this.getPersistedStateDbPath();
		if (!stateDbPath) {
			return null;
		}

		const storageKey = `secret://${JSON.stringify({
			extensionId: 'vscode.github-authentication',
			key: serviceId,
		})}`;
		const query = `select value from ItemTable where key = '${storageKey.replace(/'/g, "''")}' limit 1;`;

		try {
			const stdout = await new Promise<string>((resolve, reject) => {
				this.deps.execFile(
					'sqlite3',
					[stateDbPath, query],
					(error, output) => {
						if (error) {
							reject(error);
							return;
						}
						resolve(output);
					}
				);
			});
			const rawValue = stdout.trim();
			if (!rawValue) {
				return null;
			}

			const parsed = JSON.parse(rawValue) as unknown;
			if (typeof parsed === 'string') {
				return parsed;
			}
			if (!this.isBufferPayload(parsed)) {
				this.logParseFailure(
					`persisted-secret-shape:${serviceId}`,
					`[Copilot Auth] Persisted ${serviceId} secret did not match the expected encrypted buffer format`
				);
				return null;
			}

			const safeStorage = this.getElectronSafeStorage();
			if (!safeStorage) {
				return null;
			}

			return safeStorage.decryptString(Buffer.from(parsed.data));
		} catch (error) {
			this.logParseFailure(
				`persisted-secret-read:${serviceId}:${String(error)}`,
				`[Copilot Auth] Failed to read persisted ${serviceId} secret from ${stateDbPath}: ${String(error)}`
			);
			return null;
		}
	}

	private async getPersistedStateDbPath(): Promise<string | null> {
		if (this.persistedStateDbPath !== undefined) {
			return this.persistedStateDbPath;
		}

		for (const candidate of this.getPersistedStateDbCandidates()) {
			try {
				await fs.access(candidate);
				this.persistedStateDbPath = candidate;
				if (this.loggedPersistedStorageSummary !== candidate) {
					this.loggedPersistedStorageSummary = candidate;
					console.log(`[Copilot Auth] Found VS Code secret storage at ${candidate}`);
				}
				return candidate;
			} catch {
				continue;
			}
		}

		this.persistedStateDbPath = null;
		return null;
	}

	private getPersistedStateDbCandidates(): string[] {
		const productDirs = new Set<string>([
			...this.getCurrentProductStorageNames(),
			'Code',
			'Code - Insiders',
			'Cursor',
			'Windsurf',
			'VSCodium',
		]);
		const candidates: string[] = [];
		if (this.deps.platform === 'darwin') {
			for (const productDir of productDirs) {
				candidates.push(path.join(this.deps.homeDir, 'Library', 'Application Support', productDir, 'User', 'globalStorage', 'state.vscdb'));
			}
			return candidates;
		}

		if (this.deps.platform === 'win32') {
			const appDataDir = this.deps.env.APPDATA ?? path.join(this.deps.homeDir, 'AppData', 'Roaming');
			for (const productDir of productDirs) {
				candidates.push(path.join(appDataDir, productDir, 'User', 'globalStorage', 'state.vscdb'));
			}
			return candidates;
		}

		const configDir = this.deps.env.XDG_CONFIG_HOME ?? path.join(this.deps.homeDir, '.config');
		for (const productDir of productDirs) {
			candidates.push(path.join(configDir, productDir, 'User', 'globalStorage', 'state.vscdb'));
		}
		return candidates;
	}

	private getCurrentProductStorageNames(): string[] {
		const appName = this.deps.vscodeApi.env?.appName;
		if (typeof appName !== 'string' || appName.length === 0) {
			return [];
		}

		switch (appName) {
			case 'Visual Studio Code':
				return ['Code'];
			case 'Visual Studio Code - Insiders':
				return ['Code - Insiders'];
			default:
				return [appName];
		}
	}

	private getElectronSafeStorage(): ElectronSafeStorageLike | null {
		try {
			const electron = (eval('require') as NodeRequire)('electron') as { safeStorage?: ElectronSafeStorageLike };
			const safeStorage = electron.safeStorage;
			if (!safeStorage) {
				this.logParseFailure(
					'electron-safe-storage:missing',
					'[Copilot Auth] Electron safeStorage was not available in the extension host'
				);
				return null;
			}

			if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) {
				this.logParseFailure(
					'electron-safe-storage:disabled',
					'[Copilot Auth] Electron safeStorage reported that encryption is unavailable'
				);
				return null;
			}

			return safeStorage;
		} catch (error) {
			this.logParseFailure(
				`electron-safe-storage:${String(error)}`,
				`[Copilot Auth] Failed to load Electron safeStorage: ${String(error)}`
			);
			return null;
		}
	}

	private isBufferPayload(value: unknown): value is PersistedSecretBuffer & { type: 'Buffer'; data: number[] } {
		return this.isRecord(value)
			&& value.type === 'Buffer'
			&& Array.isArray(value.data)
			&& value.data.every(item => typeof item === 'number');
	}

	private async requestSessionAccess(
		providerId: CopilotProviderId,
		accounts: readonly vscode.AuthenticationSessionAccountInformation[]
	): Promise<void> {
		const summary = `${providerId}:${accounts.map(account => account.label).sort().join(',') || 'none'}`;
		if (this.authAccessRequestSummary === summary) {
			return;
		}

		this.authAccessRequestSummary = summary;

		try {
			const session = await this.deps.vscodeApi.authentication.getSession(
				providerId,
				[],
				{
					createIfNone: false,
					...(accounts[0] ? { account: accounts[0] } : {}),
				}
			);

			if (session) {
				console.log(
					`[Copilot Auth] VS Code granted ${providerId} session access after non-silent fallback scopes=${session.scopes.join(', ')}`
				);
				return;
			}

			console.log(
				`[Copilot Auth] Requested ${providerId} session access via VS Code Accounts menu (accounts=${accounts.map(account => account.label).join(', ') || 'none'})`
			);
		} catch (error) {
			this.logParseFailure(
				`auth-access-request:${providerId}:${String(error)}`,
				`[Copilot Auth] Failed to request ${providerId} session access: ${String(error)}`
			);
		}
	}

	private normalizeAuthEntitlementResponse(value: unknown, url: string): CopilotQuotaSnapshot | null {
		if (!this.isRecord(value)) {
			return null;
		}

		const payload = value as CopilotEntitlementResponse;
		const buckets = this.extractAuthBuckets(payload);
		if (buckets.length === 0) {
			const summary = `${url}:none`;
			if (this.loggedAuthEntitlementSummary !== summary) {
				this.loggedAuthEntitlementSummary = summary;
				console.log('[Copilot Auth] Entitlement response did not contain any quota buckets');
			}
			return null;
		}

		const selectedBucket = this.pickAuthBucket(buckets);
		if (!selectedBucket) {
			return null;
		}

		const resetDate = this.toDate(
			payload.quota_reset_date_utc
			?? payload.quota_reset_date
			?? payload.limited_user_reset_date
		);

		const plan = typeof payload.copilot_plan === 'string' ? payload.copilot_plan : 'unknown';
		const sku = typeof payload.access_type_sku === 'string' ? payload.access_type_sku : 'unknown';
		const bucketsSummary = this.describeAuthBuckets(buckets);
		const entitlementSummary = `${plan}:${sku}:${selectedBucket.name}:${bucketsSummary}`;
		if (this.loggedAuthEntitlementSummary !== entitlementSummary) {
			this.loggedAuthEntitlementSummary = entitlementSummary;
			console.log(
				`[Copilot Auth] Resolved entitlement plan=${plan} sku=${sku} selected=${selectedBucket.name} buckets=${bucketsSummary}`
			);
		}

		return {
			quota: selectedBucket.quota,
			used: selectedBucket.used,
			resetDate,
			quotaWindows: this.buildAuthQuotaWindows(buckets, resetDate),
			overageEnabled: selectedBucket.overageEnabled,
			overageUsed: selectedBucket.overageUsed,
			unlimited: selectedBucket.unlimited || selectedBucket.quota === -1,
			surface: this.classifySurfaceFromBucketName(selectedBucket.name),
			source: 'auth-entitlement',
			detail: `${url} (${selectedBucket.name})`,
			observedAt: this.deps.now(),
		};
	}

	private extractAuthBuckets(payload: CopilotEntitlementResponse): CopilotResolvedQuotaBucket[] {
		const buckets: CopilotResolvedQuotaBucket[] = [];

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
				overageEnabled: false,
				overageUsed: 0,
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

		const snapshotBuckets = payload.quota_snapshots;
		if (this.isRecord(snapshotBuckets)) {
			const bucketNames: CopilotResolvedBucketName[] = ['premium_interactions', 'premium_models', 'chat', 'completions'];
			for (const name of bucketNames) {
				const bucket = snapshotBuckets[name];
				if (!this.isRecord(bucket)) {
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
					overageEnabled: Boolean(bucket.overage_permitted),
					overageUsed: this.toFiniteNumber(bucket.overage_count) ?? 0,
					unlimited: Boolean(bucket.unlimited) || quota === -1,
				});
			}
		}

		return buckets;
	}

	private pickAuthBucket(buckets: CopilotResolvedQuotaBucket[]): CopilotResolvedQuotaBucket | null {
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

	private buildAuthQuotaWindows(
		buckets: CopilotResolvedQuotaBucket[],
		resetDate?: Date
	): QuotaWindowUsage[] | undefined {
		const windows = buckets
			.filter(bucket => !bucket.unlimited && bucket.quota > 0)
			.filter(bucket => bucket.name === 'chat' || bucket.name === 'completions')
			.sort((left, right) => this.getQuotaWindowSortOrder(left.name) - this.getQuotaWindowSortOrder(right.name))
			.map(bucket => ({
				label: this.getQuotaWindowLabel(bucket.name),
				used: Math.round(bucket.used),
				limit: Math.round(bucket.quota),
				resetTime: resetDate,
			}));

		return windows.length > 0 ? windows : undefined;
	}

	private getQuotaWindowSortOrder(bucketName: CopilotResolvedBucketName): number {
		switch (bucketName) {
			case 'chat':
				return 0;
			case 'completions':
				return 1;
			case 'premium_interactions':
				return 2;
			case 'premium_models':
				return 3;
		}
	}

	private getQuotaWindowLabel(bucketName: CopilotResolvedBucketName): string {
		switch (bucketName) {
			case 'chat':
				return 'Chat messages';
			case 'completions':
				return 'Inline suggestions';
			case 'premium_interactions':
				return 'Premium chat';
			case 'premium_models':
				return 'Premium models';
		}
	}

	private describeAuthBuckets(buckets: CopilotResolvedQuotaBucket[]): string {
		return buckets
			.map(bucket => `${bucket.name}:${Math.round(bucket.used)}/${Math.round(bucket.quota)}:${Math.round(bucket.percentRemaining)}%`)
			.join(', ');
	}

	private patchCommandExecution(): void {
		this.originalExecuteCommand = this.deps.vscodeApi.commands.executeCommand;
		const originalExecuteCommand = this.originalExecuteCommand;

		this.deps.vscodeApi.commands.executeCommand = (async <T>(command: string, ...args: unknown[]): Promise<T | undefined> => {
			if (command === 'setContext') {
				this.observeContextChange(args[0], args[1]);
			}
			return originalExecuteCommand.call(this.deps.vscodeApi.commands, command, ...args) as Promise<T | undefined>;
		}) as typeof vscode.commands.executeCommand;
	}

	private patchFetch(): void {
		if (typeof this.deps.globalObject.fetch !== 'function') {
			return;
		}

		this.originalFetch = this.deps.globalObject.fetch;
		const originalFetch = this.originalFetch;

		this.deps.globalObject.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
			const stack = new Error().stack;
			const response = await originalFetch.call(this.deps.globalObject, input, init);
			try {
				this.inspectHeaders(
					'fetch',
					response.headers,
					this.getFetchUrl(input, response.url),
					this.classifySurfaceFromStack(stack, this.findQuotaHeaderName(response.headers)),
					stack
				);
			} catch (error) {
				console.error('[Copilot Net] Failed to inspect fetch response:', error);
			}
			return response;
		}) as typeof fetch;
	}

	private patchHttps(): void {
		this.originalHttpsRequest = this.deps.httpsModule.request;
		this.originalHttpsGet = this.deps.httpsModule.get;

		const originalRequest = this.originalHttpsRequest;
		const originalGet = this.originalHttpsGet;

		this.deps.httpsModule.request = ((...args: unknown[]) => {
			const stack = new Error().stack;
			const request = originalRequest.call(this.deps.httpsModule, ...(args as Parameters<HttpsRequest>));
			this.attachNodeResponseInspector(request as NodeRequestLike, args, stack);
			return request;
		}) as HttpsRequest;

		this.deps.httpsModule.get = ((...args: unknown[]) => {
			const stack = new Error().stack;
			const request = originalGet.call(this.deps.httpsModule, ...(args as Parameters<HttpsGet>));
			this.attachNodeResponseInspector(request as NodeRequestLike, args, stack);
			return request;
		}) as HttpsGet;
	}

	private attachNodeResponseInspector(request: NodeRequestLike, args: unknown[], stack?: string): void {
		request.on('response', (response) => {
			try {
				const headerName = this.findQuotaHeaderName(response.headers ?? {});
				this.inspectHeaders(
					'https',
					response.headers ?? {},
					this.describeHttpsRequest(args),
					this.classifySurfaceFromStack(stack, headerName),
					stack
				);
			} catch (error) {
				console.error('[Copilot Net] Failed to inspect https response:', error);
			}
		});
	}

	private inspectExportValue(
		value: unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		if (depth > 4 || value === null || value === undefined) {
			return;
		}

		const fromQuotaInfo = this.normalizeQuotaInfoValue(value, `${path}.quotaInfo`, 'export-probe', surface);
		if (fromQuotaInfo) {
			this.recordSnapshot(fromQuotaInfo);
		}

		const fromCopilotToken = this.normalizeCopilotTokenValue(value, `${path}.copilotToken.quotaInfo`, surface);
		if (fromCopilotToken) {
			this.recordSnapshot(fromCopilotToken);
		}

		const fromQuotaSnapshots = this.normalizeQuotaSnapshotsValue(value, path, 'export-probe', surface);
		if (fromQuotaSnapshots) {
			this.recordSnapshot(fromQuotaSnapshots);
		}

		if (typeof value !== 'object' && typeof value !== 'function') {
			return;
		}

		const objectValue = value as object;
		if (seen.has(objectValue)) {
			return;
		}
		seen.add(objectValue);

		this.inspectKnownMethodResults(value, path, surface, depth, seen);
		this.inspectKnownGetterResults(value, path, surface, depth, seen);

		if (Array.isArray(value)) {
			for (const [index, item] of value.slice(0, 10).entries()) {
				this.inspectExportValue(item, `${path}[${index}]`, surface, depth + 1, seen);
			}
			return;
		}

		const keys = Reflect.ownKeys(value).slice(0, 20);
		for (const key of keys) {
			const entry = this.readInspectableProperty(value, key, path);
			if (entry === undefined) {
				continue;
			}
			if (typeof entry === 'function') {
				continue;
			}
			this.inspectExportValue(entry, `${path}.${String(key)}`, surface, depth + 1, seen);
		}
	}

	private inspectKnownMethodResults(
		value: unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		const getAPIMethod = this.readCallableProperty(value, 'getAPI');
		if (getAPIMethod) {
			this.inspectDerivedValue(() => getAPIMethod.call(value, 1), `${path}.getAPI(1)`, surface, depth, seen);
		}

		const getContextProviderAPIMethod = this.readCallableProperty(value, 'getContextProviderAPI');
		if (getContextProviderAPIMethod) {
			this.inspectDerivedValue(() => getContextProviderAPIMethod.call(value, undefined), `${path}.getContextProviderAPI()`, surface, depth, seen);
		}
	}

	private inspectKnownGetterResults(
		value: unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		let prototype = Object.getPrototypeOf(value);
		let prototypeDepth = 0;

		while (prototype && prototype !== Object.prototype && prototype !== Function.prototype && prototypeDepth < 2) {
			for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) {
				if (!SAFE_GETTER_NAMES.has(name) || typeof descriptor.get !== 'function') {
					continue;
				}

				this.inspectDerivedValue(
					() => descriptor.get?.call(value),
					`${path}.${name}`,
					surface,
					depth,
					seen
				);
			}

			prototype = Object.getPrototypeOf(prototype);
			prototypeDepth += 1;
		}
	}

	private inspectDerivedValue(
		compute: () => unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		try {
			const derivedValue = compute();
			if (derivedValue === undefined) {
				return;
			}

			this.logDerivedSummary(path, derivedValue);
			this.inspectExportValue(derivedValue, path, surface, depth + 1, seen);
		} catch (error) {
			this.logParseFailure(path, `[Copilot Probe] Failed to inspect ${path}: ${String(error)}`);
		}
	}

	private inspectHeaders(
		source: CopilotSignalSource,
		headers: HeadersLike,
		url: string,
		surface: CopilotSurface,
		stack?: string
	): void {
		const header = this.findQuotaHeader(headers);
		if (!header) {
			return;
		}

		const parsed = this.parseQuotaHeader(header.name, header.value, source, surface, url);
		if (!parsed) {
			this.logParseFailure(`${source}:${header.name}:${header.value}`, `[Copilot Net] Failed to parse ${header.name} from ${url}`);
			return;
		}

		const stackSummary = this.summarizeStack(stack);
		const detail = `${url} (${header.name}${stackSummary ? `; ${stackSummary}` : ''})`;
		this.recordSnapshot({
			...parsed,
			detail,
		});
	}

	private normalizeQuotaInfoValue(
		value: unknown,
		detail: string,
		source: CopilotSignalSource,
		surface: CopilotSurface
	): CopilotQuotaSnapshot | null {
		const quotaInfo = this.readQuotaInfo(value);
		if (!quotaInfo) {
			return null;
		}

		const quota = this.toFiniteNumber(quotaInfo.quota);
		const used = this.toFiniteNumber(quotaInfo.used);
		if (quota === null || used === null) {
			return null;
		}

		return {
			quota,
			used,
			resetDate: this.toDate(quotaInfo.resetDate),
			overageEnabled: Boolean(quotaInfo.overageEnabled),
			overageUsed: this.toFiniteNumber(quotaInfo.overageUsed) ?? 0,
			unlimited: Boolean(quotaInfo.unlimited) || quota === -1,
			surface,
			source,
			detail,
			observedAt: this.deps.now(),
		};
	}

	private normalizeCopilotTokenValue(
		value: unknown,
		detail: string,
		surface: CopilotSurface
	): CopilotQuotaSnapshot | null {
		if (!this.isRecord(value) || !('copilotToken' in value)) {
			return null;
		}

		return this.normalizeQuotaInfoValue((value as { copilotToken?: unknown }).copilotToken, detail, 'export-probe', surface);
	}

	private normalizeQuotaSnapshotsValue(
		value: unknown,
		detail: string,
		source: CopilotSignalSource,
		surface: CopilotSurface
	): CopilotQuotaSnapshot | null {
		if (!this.isRecord(value) || !('quota_snapshots' in value) || !('quota_reset_date' in value)) {
			return null;
		}

		const snapshots = (value as { quota_snapshots?: unknown }).quota_snapshots;
		if (!this.isRecord(snapshots)) {
			return null;
		}

		const bucket = this.readQuotaSnapshotBucket(snapshots);
		if (!bucket) {
			return null;
		}

		const quota = this.toFiniteNumber(bucket.entitlement);
		const percentRemaining = this.toFiniteNumber(bucket.percent_remaining);
		if (quota === null || percentRemaining === null) {
			return null;
		}

		return {
			quota,
			used: Math.max(0, quota * (1 - percentRemaining / 100)),
			resetDate: this.toDate((value as { quota_reset_date?: unknown }).quota_reset_date),
			overageEnabled: Boolean(bucket.overage_permitted),
			overageUsed: this.toFiniteNumber(bucket.overage_count) ?? 0,
			unlimited: Boolean(bucket.unlimited) || quota === -1,
			surface,
			source,
			detail,
			observedAt: this.deps.now(),
		};
	}

	private parseQuotaHeader(
		headerName: CopilotQuotaHeaderName,
		rawValue: string,
		source: CopilotSignalSource,
		surface: CopilotSurface,
		url: string
	): CopilotQuotaSnapshot | null {
		try {
			const params = new URLSearchParams(rawValue);
			const quota = this.toFiniteNumber(params.get('ent'));
			const percentRemaining = this.toFiniteNumber(params.get('rem'));
			if (quota === null || percentRemaining === null) {
				return null;
			}

			const resetDate = this.toDate(params.get('rst'));
			return {
				quota,
				used: Math.max(0, quota * (1 - percentRemaining / 100)),
				resetDate,
				overageEnabled: params.get('ovPerm') === 'true',
				overageUsed: this.toFiniteNumber(params.get('ov')) ?? 0,
				unlimited: quota === -1,
				surface,
				source,
				detail: `${url} (${headerName})`,
				observedAt: this.deps.now(),
			};
		} catch (error) {
			this.logParseFailure(`${source}:${headerName}:${rawValue}`, `[Copilot Net] Failed to parse ${headerName}: ${String(error)}`);
			return null;
		}
	}

	private recordSnapshot(snapshot: CopilotQuotaSnapshot): void {
		const signalKey = `${snapshot.source}:${snapshot.detail}`;
		if (!this.loggedSignalSources.has(signalKey)) {
			this.loggedSignalSources.add(signalKey);
			const prefix = snapshot.source === 'auth-entitlement'
				? '[Copilot Auth]'
				: snapshot.source === 'export-probe'
					? '[Copilot Probe]'
					: '[Copilot Net]';
			console.log(`${prefix} Observed ${snapshot.source} signal (${snapshot.surface}) from ${snapshot.detail}`);
		}

		const previousKey = this.currentSnapshot ? this.snapshotKey(this.currentSnapshot) : null;
		this.currentSnapshot = snapshot;
		this.waitingForSignalLogged = false;

		if (previousKey === this.snapshotKey(snapshot)) {
			return;
		}

		if (snapshot.unlimited || snapshot.quota <= 0) {
			console.log(
				`[Copilot] Updated shared quota snapshot but hiding ${SERVICE_NAME} because the quota is unbounded (quota=${snapshot.quota}, unlimited=${snapshot.unlimited})`
			);
			return;
		}

		console.log(
			`[Copilot] Updated shared quota snapshot (${snapshot.surface}) used=${Math.round(snapshot.used)}/${Math.round(snapshot.quota)} reset=${snapshot.resetDate?.toISOString() ?? 'unknown'} via ${snapshot.source}`
		);
	}

	private observeContextChange(key: unknown, value: unknown): void {
		if (key === CHAT_QUOTA_CONTEXT_KEY) {
			const next = Boolean(value);
			if (this.chatQuotaExceeded !== next) {
				this.chatQuotaExceeded = next;
				console.log(`[Copilot Context] ${CHAT_QUOTA_CONTEXT_KEY}=${next}`);
			}
			return;
		}

		if (key === COMPLETIONS_QUOTA_CONTEXT_KEY) {
			const next = Boolean(value);
			if (this.completionsQuotaExceeded !== next) {
				this.completionsQuotaExceeded = next;
				console.log(`[Copilot Context] ${COMPLETIONS_QUOTA_CONTEXT_KEY}=${next}`);
			}
		}
	}

	private getInstalledExtensions(): Array<vscode.Extension<unknown>> {
		const exactMatches = COPILOT_EXTENSION_IDS
			.map(id => this.deps.vscodeApi.extensions.getExtension(id))
			.filter((extension): extension is vscode.Extension<unknown> => Boolean(extension));
		const exactMatchIds = new Set(exactMatches.map(extension => extension.id.toLowerCase()));
		const discoveredMatches = this.deps.vscodeApi.extensions.all.filter(extension =>
			NORMALIZED_COPILOT_EXTENSION_IDS.has(extension.id.toLowerCase())
			&& !exactMatchIds.has(extension.id.toLowerCase())
		);
		const matches = [...exactMatches, ...discoveredMatches];
		const discoverySummary = matches.map(extension => extension.id).sort().join(', ') || 'none';

		if (this.loggedDiscoverySummary !== discoverySummary) {
			this.loggedDiscoverySummary = discoverySummary;
			console.log(`[Copilot Probe] discovered Copilot extensions: ${discoverySummary}`);
		}

		return matches;
	}

	private describeExportValue(value: unknown): string {
		if (value === null || value === undefined) {
			return String(value);
		}

		if (Array.isArray(value)) {
			return `array(length=${value.length})`;
		}

		if (typeof value !== 'object') {
			return typeof value;
		}

		const keys = Reflect.ownKeys(value)
			.map(key => String(key))
			.slice(0, 12);
		const prototype = Object.getPrototypeOf(value);
		const prototypeKeys = prototype && prototype !== Object.prototype
			? Object.getOwnPropertyNames(prototype)
				.filter(key => key !== 'constructor')
				.slice(0, 8)
			: [];

		const ownSummary = keys.length === 0 ? 'keys=none' : `keys=${keys.join(', ')}`;
		if (prototypeKeys.length === 0) {
			return `object(${ownSummary})`;
		}
		return `object(${ownSummary}; proto=${prototypeKeys.join(', ')})`;
	}

	private classifySurfaceFromExtensionId(extensionId: string): CopilotSurface {
		return extensionId === 'GitHub.copilot-chat' ? 'chat' : 'completions';
	}

	private classifySurfaceFromBucketName(bucketName: CopilotResolvedBucketName): CopilotSurface {
		if (bucketName === 'chat') {
			return 'chat';
		}
		if (bucketName === 'completions') {
			return 'completions';
		}
		return 'premium';
	}

	private classifySurfaceFromStack(stack?: string, headerName?: CopilotQuotaHeaderName | null): CopilotSurface {
		if (headerName === 'x-quota-snapshot-chat') {
			return 'chat';
		}
		if (headerName === 'x-quota-snapshot-premium_interactions' || headerName === 'x-quota-snapshot-premium_models') {
			return 'premium';
		}

		if (!stack) {
			return 'unknown';
		}

		const normalizedStack = stack.toLowerCase();
		if (normalizedStack.includes('github.copilot-chat')) {
			return 'chat';
		}
		if (normalizedStack.includes('github.copilot-') || normalizedStack.includes('github.copilot/')) {
			return 'completions';
		}
		return 'unknown';
	}

	private summarizeStack(stack?: string): string {
		if (!stack) {
			return '';
		}

		const lines = stack
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.includes('github.copilot'));

		return lines[0] ?? '';
	}

	private getFetchUrl(input: Request | string | URL, fallbackUrl: string): string {
		if (typeof input === 'string') {
			return input;
		}
		if (input instanceof URL) {
			return input.toString();
		}
		if ('url' in input && typeof input.url === 'string') {
			return input.url;
		}
		return fallbackUrl || 'unknown fetch request';
	}

	private describeHttpsRequest(args: unknown[]): string {
		const [first, second] = args;
		if (first instanceof URL) {
			return first.toString();
		}
		if (typeof first === 'string') {
			return first;
		}
		if (this.isRecord(first)) {
			return this.describeHttpsOptions(first);
		}
		if (this.isRecord(second)) {
			return this.describeHttpsOptions(second);
		}
		return 'unknown https request';
	}

	private describeHttpsOptions(options: Record<string, unknown>): string {
		const protocol = typeof options.protocol === 'string' ? options.protocol : 'https:';
		const host = typeof options.hostname === 'string'
			? options.hostname
			: typeof options.host === 'string'
				? options.host
				: 'unknown-host';
		const path = typeof options.path === 'string' ? options.path : '';
		return `${protocol}//${host}${path}`;
	}

	private findQuotaHeader(headers: HeadersLike): { name: CopilotQuotaHeaderName; value: string } | null {
		for (const headerName of QUOTA_HEADER_PRIORITY) {
			const headerValue = this.getHeaderValue(headers, headerName);
			if (headerValue) {
				return { name: headerName, value: headerValue };
			}
		}
		return null;
	}

	private findQuotaHeaderName(headers: HeadersLike): CopilotQuotaHeaderName | null {
		return this.findQuotaHeader(headers)?.name ?? null;
	}

	private getHeaderValue(headers: HeadersLike, headerName: string): string | null {
		if (typeof (headers as Headers).get === 'function') {
			return (headers as Headers).get(headerName);
		}

		const lowerHeaderName = headerName.toLowerCase();
		const headerValue = Object.entries(headers).find(([name]) => name.toLowerCase() === lowerHeaderName)?.[1];
		if (Array.isArray(headerValue)) {
			return headerValue[0] ?? null;
		}
		return headerValue ?? null;
	}

	private readInspectableProperty(value: unknown, key: PropertyKey, path: string): unknown {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) {
			return undefined;
		}

		if ('value' in descriptor) {
			return descriptor.value;
		}

		if (!SAFE_GETTER_NAMES.has(String(key)) || typeof descriptor.get !== 'function') {
			return undefined;
		}

		try {
			return descriptor.get.call(value);
		} catch (error) {
			this.logParseFailure(`${path}.${String(key)}`, `[Copilot Probe] Failed to inspect ${path}.${String(key)}: ${String(error)}`);
			return undefined;
		}
	}

	private readCallableProperty(value: unknown, propertyName: string): ((...args: unknown[]) => unknown) | null {
		if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
			return null;
		}

		const candidate = Reflect.get(value, propertyName);
		return typeof candidate === 'function' ? candidate as (...args: unknown[]) => unknown : null;
	}

	private readQuotaInfo(value: unknown): CopilotQuotaInfoLike | null {
		if (!this.isRecord(value)) {
			return null;
		}

		if (this.isRecord((value as { quotaInfo?: unknown }).quotaInfo)) {
			return (value as { quotaInfo: CopilotQuotaInfoLike }).quotaInfo;
		}

		const hasQuotaInfoFields = 'quota' in value || 'used' in value || 'resetDate' in value;
		return hasQuotaInfoFields ? value as CopilotQuotaInfoLike : null;
	}

	private readQuotaSnapshotBucket(value: Record<string, unknown>): CopilotQuotaSnapshotBucket | null {
		const candidateKeys = ['premium_interactions', 'premium_models', 'chat'];
		for (const key of candidateKeys) {
			const bucket = value[key];
			if (this.isRecord(bucket)) {
				return bucket as CopilotQuotaSnapshotBucket;
			}
		}
		return null;
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

	private snapshotKey(snapshot: CopilotQuotaSnapshot): string {
		return JSON.stringify({
			quota: snapshot.quota,
			quotaWindows: snapshot.quotaWindows?.map(window => ({
				label: window.label,
				used: window.used,
				limit: window.limit,
				resetTime: window.resetTime?.toISOString() ?? null,
			})) ?? null,
			used: snapshot.used,
			resetDate: snapshot.resetDate?.toISOString() ?? null,
			overageEnabled: snapshot.overageEnabled,
			overageUsed: snapshot.overageUsed,
			unlimited: snapshot.unlimited,
			surface: snapshot.surface,
		});
	}

	private logDerivedSummary(path: string, value: unknown): void {
		const summary = this.describeExportValue(value);
		if (this.loggedDerivedSummaries.get(path) === summary) {
			return;
		}

		this.loggedDerivedSummaries.set(path, summary);
		console.log(`[Copilot Probe] ${path} => ${summary}`);
	}

	private logParseFailure(key: string, message: string): void {
		if (this.loggedParseFailures.has(key)) {
			return;
		}

		this.loggedParseFailures.add(key);
		console.error(message);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}
}
