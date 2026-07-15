import { getShortServiceLabel } from './services';
import { UsageData, UsageDisplayMode, UsageStatus, getUsageStatus } from './types';
import { formatTimeUntilReset } from './utils';

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

export function getUsedPercent(used: number, limit: number): number {
	if (limit === 0) {
		return 0;
	}

	const percent = limit === 100
		? used
		: Math.round((used / limit) * 100);

	return clampPercent(percent);
}

/** Round to hundredths and strip binary float noise (e.g. 20 - 18.68 → 1.3200000000000003). */
export function roundUsageNumber(value: number): number {
	if (!Number.isFinite(value)) {
		return value;
	}

	return Number(value.toFixed(2));
}

/**
 * Format a usage quantity for status bar / dashboard text.
 * Always shows at most 2 decimal places; omits ".00" for whole numbers.
 */
export function formatUsageNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return String(value);
	}

	const fixed = roundUsageNumber(value).toFixed(2);
	return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}

export function getRemainingValue(used: number, limit: number): number {
	return Math.max(0, roundUsageNumber(limit - used));
}

export function getDisplayValue(used: number, limit: number, mode: UsageDisplayMode): number {
	return mode === 'remaining' ? getRemainingValue(used, limit) : used;
}

export function getDisplayPercent(used: number, limit: number, mode: UsageDisplayMode): number {
	if (limit === 0) {
		return 0;
	}

	const usedPercent = getUsedPercent(used, limit);
	return mode === 'remaining' ? 100 - usedPercent : usedPercent;
}

export function formatUsageDisplay(used: number, limit: number, mode: UsageDisplayMode): string {
	const value = getDisplayValue(used, limit, mode);
	if (limit === 100) {
		return `${formatUsageNumber(value)}%`;
	}

	return `${formatUsageNumber(value)}/${formatUsageNumber(limit)}`;
}

export function getDisplayModeVerb(mode: UsageDisplayMode): string {
	return mode === 'remaining' ? 'left' : 'used';
}

export interface UsageMetricViewModel {
	used: number;
	limit: number;
	displayText: string;
	displayValueText: string;
	displayUnit: string;
	displayPercent: number;
	displayVerb: string;
	status: UsageStatus;
	statusEmoji: string;
	resetTime?: Date;
	resetText?: string;
}

export interface ServiceViewModel extends UsageMetricViewModel {
	serviceId: UsageData['serviceId'];
	serviceName: string;
	shortLabel: string;
	summaryText: string;
	progressSegments?: number;
	lastUpdated: Date;
	quotaWindows?: UsageMetricViewModel[];
	models?: UsageData['models'];
}

function getStatusEmoji(status: UsageStatus): string {
	switch (status) {
		case UsageStatus.CRITICAL:
			return '🔴';
		case UsageStatus.WARNING:
			return '🟡';
		default:
			return '🟢';
	}
}

export function buildUsageBlock(percent: number, totalBlocks = 10): string {
	const clampedPercent = clampPercent(percent);
	const filledBlocks = Math.round(clampedPercent / (100 / totalBlocks));
	return '█'.repeat(filledBlocks) + '░'.repeat(totalBlocks - filledBlocks);
}

export function toUsageMetricViewModel(
	used: number,
	limit: number,
	resetTime: Date | undefined,
	displayMode: UsageDisplayMode
): UsageMetricViewModel {
	const status = getUsageStatus(used, limit);
	const displayValue = getDisplayValue(used, limit, displayMode);
	return {
		used,
		limit,
		displayText: formatUsageDisplay(used, limit, displayMode),
		displayValueText: formatUsageNumber(displayValue),
		displayUnit: limit === 100 ? '%' : '',
		displayPercent: getDisplayPercent(used, limit, displayMode),
		displayVerb: getDisplayModeVerb(displayMode),
		status,
		statusEmoji: getStatusEmoji(status),
		resetTime,
		resetText: resetTime ? formatTimeUntilReset(resetTime) : undefined,
	};
}

export function toServiceViewModel(data: UsageData, displayMode: UsageDisplayMode): ServiceViewModel {
	const usage = toUsageMetricViewModel(data.totalUsed, data.totalLimit, data.resetTime, displayMode);
	return {
		...usage,
		serviceId: data.serviceId,
		serviceName: data.serviceName,
		shortLabel: getShortServiceLabel(data.serviceId, data.serviceName),
		summaryText: usage.status === UsageStatus.CRITICAL && usage.resetText ? `↻${usage.resetText}` : usage.displayText,
		progressSegments: data.progressSegments,
		lastUpdated: data.lastUpdated,
		quotaWindows: data.quotaWindows?.map((window) =>
			toUsageMetricViewModel(window.used, window.limit, window.resetTime, displayMode)
		),
		models: data.models,
	};
}
