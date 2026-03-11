import * as vscode from 'vscode';
import { QuotaWindowUsage } from '../types';

export const SERVICE_NAME = 'VSCode Copilot';
export const CHAT_QUOTA_CONTEXT_KEY = 'github.copilot.chat.quotaExceeded';
export const COMPLETIONS_QUOTA_CONTEXT_KEY = 'github.copilot.completions.quotaExceeded';
export const COPILOT_DEFAULT_PROVIDER_ID = 'github';
export const COPILOT_ENTERPRISE_PROVIDER_ID = 'github-enterprise';
export const COPILOT_DEFAULT_ENTITLEMENT_URL = 'https://api.github.com/copilot_internal/user';
export const COPILOT_SCOPE_SETS = [
	['user:email'],
	['read:user'],
	['read:user', 'user:email', 'repo', 'workflow'],
] as const;
export const COPILOT_ADVANCED_SECTION = 'github.copilot';
export const COPILOT_ADVANCED_KEY = 'advanced';
export const COPILOT_ENTERPRISE_SECTION = 'github-enterprise';
export const COPILOT_ENTERPRISE_URI_KEY = 'uri';
export const AUTH_FETCH_TTL = 60 * 1000;
export const COPILOT_EXTENSION_IDS = ['GitHub.copilot', 'GitHub.copilot-chat'] as const;
export const NORMALIZED_COPILOT_EXTENSION_IDS = new Set(
	COPILOT_EXTENSION_IDS.map(id => id.toLowerCase())
);
export const QUOTA_HEADER_PRIORITY = [
	'x-quota-snapshot-premium_interactions',
	'x-quota-snapshot-premium_models',
	'x-quota-snapshot-chat',
] as const;
export const SAFE_GETTER_NAMES = new Set([
	'quotaInfo',
	'raw',
	'userInfo',
	'copilotToken',
	'token',
]);

export type CopilotSurface = 'chat' | 'completions' | 'premium' | 'unknown';
export type CopilotSignalSource = 'auth-entitlement' | 'export-probe' | 'fetch' | 'https';
export type CopilotProviderId = typeof COPILOT_DEFAULT_PROVIDER_ID | typeof COPILOT_ENTERPRISE_PROVIDER_ID;
export type CopilotQuotaHeaderName = typeof QUOTA_HEADER_PRIORITY[number];
export type HttpsModule = typeof import('https');
export type HttpsRequest = typeof import('https').request;
export type HttpsGet = typeof import('https').get;
export type ExecFile = typeof import('child_process').execFile;

export interface CopilotQuotaSnapshot {
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

export interface CopilotQuotaInfoLike {
	quota?: unknown;
	used?: unknown;
	resetDate?: unknown;
	overageEnabled?: unknown;
	overageUsed?: unknown;
	unlimited?: unknown;
}

export interface CopilotQuotaSnapshotBucket {
	entitlement?: unknown;
	remaining?: unknown;
	percent_remaining?: unknown;
	overage_permitted?: unknown;
	overage_count?: unknown;
	unlimited?: unknown;
}

export interface CopilotEntitlementResponse {
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

export type CopilotResolvedBucketName = 'chat' | 'completions' | 'premium_interactions' | 'premium_models';

export interface CopilotResolvedQuotaBucket {
	name: CopilotResolvedBucketName;
	quota: number;
	used: number;
	percentRemaining: number;
	overageEnabled: boolean;
	overageUsed: number;
	unlimited: boolean;
}

export interface CopilotSessionLike {
	id: string;
	accessToken: string;
	account: {
		id: string;
		label: string;
	};
	scopes: readonly string[];
}

export interface CopilotStoredSession {
	id?: unknown;
	accessToken?: unknown;
	account?: {
		id?: unknown;
		label?: unknown;
		displayName?: unknown;
	};
	scopes?: unknown;
}

export interface PersistedSecretBuffer {
	type?: unknown;
	data?: unknown;
}

export interface ElectronSafeStorageLike {
	decryptString(buffer: Buffer): string;
	isEncryptionAvailable?(): boolean;
}

export interface CopilotProviderDeps {
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

export interface ResolvedCopilotProviderDeps {
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

export type HeaderValue = string | string[] | undefined;
export type HeadersLike = Headers | Record<string, HeaderValue>;
export type NodeRequestLike = {
	on(event: 'response', listener: (response: { headers?: Record<string, HeaderValue> }) => void): unknown;
};
