export const SERVICE_IDS = ['claudeCode', 'codex', 'vscodeCopilot', 'copilotCli', 'cursor', 'antigravity', 'gemini', 'kiro'] as const;
export type ServiceId = typeof SERVICE_IDS[number];

/**
 * Usage data for a model or service
 */
export interface ModelUsage {
	modelName: string;
	used: number;
	limit: number;
	resetTime?: Date;
}

export type UsageDisplayMode = 'used' | 'remaining';
export type StatusBarTooltipLayout = 'regular' | 'monospaced';

/**
 * Usage data for a quota window, such as 5-hour or 7-day limits
 */
export interface QuotaWindowUsage {
	label: string;
	used: number;
	limit: number;
	resetTime?: Date;
}

/**
 * Non-quota health states that a provider can report alongside (or instead of) usage data.
 * Used to keep a service visible in the UI when we know why quota data is unavailable.
 */
export type ServiceHealthKind = 'reauthRequired' | 'rateLimited' | 'unavailable';

/**
 * Provider-reported health state for a registered service instance.
 */
export interface ServiceHealth {
	kind: ServiceHealthKind;
	summary: string;
	detail?: string;
	lastUpdated: Date;
}

/**
 * Merged view of a registered provider: quota usage when available, and/or health state.
 */
export interface ServiceSnapshot {
	serviceId: ServiceId;
	serviceName: string;
	usage?: UsageData;
	health?: ServiceHealth;
}

/**
 * Complete usage data for a service
 */
export interface UsageData {
	serviceId: ServiceId;
	serviceName: string;
	totalUsed: number;
	totalLimit: number;
	resetTime?: Date;
	progressSegments?: number;
	quotaWindows?: QuotaWindowUsage[];
	models?: ModelUsage[];
	lastUpdated: Date;
	/** Optional dedup key — entries with the same accountKey across providers are deduplicated (first wins) */
	accountKey?: string;
	/** Label to use when this entry wins a dedup (overrides serviceName) */
	accountKeyLabel?: string;
}

/**
 * Service configuration
 */
export interface ServiceConfig {
	enabled: boolean;
	models?: string[]; // Specific models to track, empty = all
}

/**
 * All services configuration
 */
export type ServicesConfig = Partial<Record<ServiceId, ServiceConfig>>;

/**
 * Usage status for UI display
 */
export enum UsageStatus {
	OK = 'ok',        // Plenty of quota remaining
	WARNING = 'warning', // Near limit
	CRITICAL = 'critical' // Hit limit or very close
}

/**
 * Calculate status based on usage percentage
 */
export function getUsageStatus(used: number, limit: number): UsageStatus {
	if (limit === 0) return UsageStatus.CRITICAL;
	const percentage = (used / limit) * 100;
	if (percentage >= 100) return UsageStatus.CRITICAL;
	if (percentage >= 80) return UsageStatus.WARNING;
	return UsageStatus.OK;
}
