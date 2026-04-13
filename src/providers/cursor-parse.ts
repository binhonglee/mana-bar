import { QuotaWindowUsage, UsageData } from '../types';

interface CursorPlanUsage {
	totalSpend?: unknown;
	includedSpend?: unknown;
	limit?: unknown;
	autoPercentUsed?: unknown;
	apiPercentUsed?: unknown;
	totalPercentUsed?: unknown;
}

export interface CursorCurrentPeriodUsageResponse {
	billingCycleEnd?: unknown;
	planUsage?: CursorPlanUsage;
}

export interface CursorPricingResponse {
	hasAutoSpillover?: unknown;
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function toDateFromEpochMillis(value: unknown): Date | undefined {
	const millis = toFiniteNumber(value);
	if (millis === null || millis <= 0) {
		return undefined;
	}

	const date = new Date(millis);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function toPercentWindow(label: string, percent: number, resetTime: Date | undefined): QuotaWindowUsage {
	const clamped = Math.max(0, Math.min(100, percent));
	return {
		label,
		used: Math.round(clamped),
		limit: 100,
		resetTime,
	};
}

export function parseCursorUsageResponse(
	response: CursorCurrentPeriodUsageResponse,
	pricing: CursorPricingResponse | null,
	serviceName = 'Cursor',
	lastUpdated = new Date()
): UsageData | null {
	const planUsage = response.planUsage;
	if (!planUsage) {
		return null;
	}

	const includedSpendCents = toFiniteNumber(planUsage.includedSpend);
	const limitCents = toFiniteNumber(planUsage.limit);
	if (includedSpendCents === null || limitCents === null || limitCents <= 0) {
		return null;
	}

	const resetTime = toDateFromEpochMillis(response.billingCycleEnd);
	const spendUsed = Math.round(includedSpendCents) / 100;
	const spendLimit = Math.round(limitCents) / 100;
	const hasAutoSpillover = pricing?.hasAutoSpillover === true;
	const autoPercentUsed = toFiniteNumber(planUsage.autoPercentUsed);
	const apiPercentUsed = toFiniteNumber(planUsage.apiPercentUsed);

	// When hasAutoSpillover, pick the most critical percentage quota for totalUsed/totalLimit
	// (like Codex/Claude Code do), and include spend + all quotas in quotaWindows for dashboard
	if (hasAutoSpillover && (autoPercentUsed !== null || apiPercentUsed !== null)) {
		const quotaWindows: QuotaWindowUsage[] = [
			{ label: 'Spend', used: spendUsed, limit: spendLimit, resetTime },
		];
		if (autoPercentUsed !== null) {
			quotaWindows.push(toPercentWindow('Auto + Composer', autoPercentUsed, resetTime));
		}
		if (apiPercentUsed !== null) {
			quotaWindows.push(toPercentWindow('API', apiPercentUsed, resetTime));
		}

		// Select the critical (highest) percentage for totalUsed/totalLimit
		const criticalPercent = Math.max(autoPercentUsed ?? 0, apiPercentUsed ?? 0);

		return {
			serviceId: 'cursor',
			serviceName,
			totalUsed: Math.round(criticalPercent),
			totalLimit: 100,
			resetTime,
			quotaWindows,
			models: [],
			lastUpdated,
		};
	}

	// Without hasAutoSpillover, just use dollar spend
	return {
		serviceId: 'cursor',
		serviceName,
		totalUsed: spendUsed,
		totalLimit: spendLimit,
		resetTime,
		models: [],
		lastUpdated,
	};
}
