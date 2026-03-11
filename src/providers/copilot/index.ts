import * as vscode from 'vscode';
import * as os from 'os';
import { execFile as defaultExecFile } from 'child_process';
const defaultHttpsModule = require('https');

import { UsageData } from '../../types';
import { UsageProvider } from '../base';
import {
	AUTH_FETCH_TTL,
	CHAT_QUOTA_CONTEXT_KEY,
	COMPLETIONS_QUOTA_CONTEXT_KEY,
	COPILOT_DEFAULT_ENTITLEMENT_URL,
	COPILOT_DEFAULT_PROVIDER_ID,
	COPILOT_ENTERPRISE_PROVIDER_ID,
	COPILOT_ENTERPRISE_SECTION,
	COPILOT_ENTERPRISE_URI_KEY,
	COPILOT_ADVANCED_SECTION,
	COPILOT_ADVANCED_KEY,
	CopilotProviderDeps,
	CopilotProviderId,
	CopilotQuotaSnapshot,
	ResolvedCopilotProviderDeps,
	SERVICE_NAME
} from './types';
import { CopilotAuthManager } from './auth';
import { CopilotParser } from './parse';
import { CopilotProbeManager } from './probe';
import { CopilotNetInterceptor } from './net';

export class CopilotProvider extends UsageProvider {
	private readonly deps: ResolvedCopilotProviderDeps;
	private initialized = false;
	private currentSnapshot: CopilotQuotaSnapshot | null = null;
	private loggedSignalSources = new Set<string>();
	private loggedParseFailures = new Set<string>();
	private loggedAuthSessionSummary: string | null = null;
	private loggedAuthEntitlementSummary: string | null = null;
	private waitingForSignalLogged = false;

	private exportProbePromise: Promise<void> | null = null;
	private authFetchPromise: Promise<void> | null = null;
	private authFetchExpiry = 0;

	private chatQuotaExceeded: boolean | null = null;
	private completionsQuotaExceeded: boolean | null = null;

	private originalExecuteCommand?: typeof vscode.commands.executeCommand;
	private authChangeDisposable?: vscode.Disposable;
	private extensionsChangeDisposable?: vscode.Disposable;

	private readonly authManager: CopilotAuthManager;
	private readonly parser: CopilotParser;
	private readonly probeManager: CopilotProbeManager;
	private readonly netInterceptor: CopilotNetInterceptor;

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

		const logParseFailure = (key: string, message: string) => this.logParseFailure(key, message);
		const recordSnapshot = (snapshot: CopilotQuotaSnapshot) => this.recordSnapshot(snapshot);

		this.parser = new CopilotParser(this.deps, logParseFailure);
		this.authManager = new CopilotAuthManager(this.deps, logParseFailure);
		this.probeManager = new CopilotProbeManager(this.deps, this.parser, recordSnapshot, logParseFailure);
		this.netInterceptor = new CopilotNetInterceptor(this.deps, this.parser, recordSnapshot, logParseFailure);
	}

	getServiceName(): string {
		return SERVICE_NAME;
	}

	async isAvailable(): Promise<boolean> {
		const providerId = this.getPreferredProviderId();
		const hasPersistedSession = await this.authManager.hasPersistedSession(providerId);

		// Check if extension is installed by seeing if any extension IDs match
		// This is a bit indirect but matches previous logic
		const installedExtensions = this.deps.vscodeApi.extensions.all.filter(e =>
			e.id.toLowerCase().includes('github.copilot')
		);

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

		this.netInterceptor.dispose();
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}

		this.initialized = true;
		console.log('[Copilot] Initializing VSCode Copilot provider');

		this.patchCommandExecution();
		this.netInterceptor.patchFetch();
		this.netInterceptor.patchHttps();

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

		this.exportProbePromise = this.probeManager.performExportProbe(reason).finally(() => {
			this.exportProbePromise = null;
		});

		return this.exportProbePromise;
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
		const fetchImplementation = (this.netInterceptor as any).originalFetch ?? this.deps.globalObject.fetch;
		if (typeof fetchImplementation !== 'function') {
			return;
		}

		const providerId = this.getPreferredProviderId();
		const session = await this.authManager.findCopilotSession(providerId);
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
			const snapshot = this.parser.normalizeAuthEntitlementResponse(payload, entitlementUrl);
			if (snapshot) {
				const plan = (payload as any).copilot_plan === 'string' ? (payload as any).copilot_plan : 'unknown';
				const sku = (payload as any).access_type_sku === 'string' ? (payload as any).access_type_sku : 'unknown';
				const buckets = this.parser.extractAuthBuckets(payload as any);
				const bucketsSummary = this.parser.describeAuthBuckets(buckets);
				const entitlementSummary = `${plan}:${sku}:${snapshot.surface}:${bucketsSummary}`;
				if (this.loggedAuthEntitlementSummary !== entitlementSummary) {
					this.loggedAuthEntitlementSummary = entitlementSummary;
					console.log(
						`[Copilot Auth] Resolved entitlement plan=${plan} sku=${sku} selected=${snapshot.surface} buckets=${bucketsSummary}`
					);
				}
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

		this.currentSnapshot = snapshot;
		this.waitingForSignalLogged = false;

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

	private logParseFailure(key: string, message: string): void {
		if (this.loggedParseFailures.has(key)) {
			return;
		}

		this.loggedParseFailures.add(key);
		console.error(message);
	}
}
