import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	CopilotProviderId,
	CopilotSessionLike,
	COPILOT_SCOPE_SETS,
	COPILOT_ENTERPRISE_PROVIDER_ID,
	COPILOT_ENTERPRISE_SECTION,
	COPILOT_ENTERPRISE_URI_KEY,
	CopilotStoredSession,
	ResolvedCopilotProviderDeps,
	PersistedSecretBuffer,
	ElectronSafeStorageLike
} from './types';
import { isRecord } from './utils';

export class CopilotAuthManager {
	private persistedStateDbPath: string | null | undefined;
	private loggedPersistedSessionSummary: string | null = null;
	private loggedPersistedStorageSummary: string | null = null;
	private loggedAuthNoSessionSummary: string | null = null;
	private authAccessRequestSummary: string | null = null;

	constructor(
		private readonly deps: ResolvedCopilotProviderDeps,
		private readonly logParseFailure: (key: string, message: string) => void
	) { }

	async findCopilotSession(providerId: CopilotProviderId): Promise<CopilotSessionLike | null> {
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

	async hasPersistedSession(providerId: CopilotProviderId): Promise<boolean> {
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
		if (!isRecord(value)) {
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

		const account = isRecord(session.account) ? session.account : undefined;
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
		return isRecord(value)
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
}
