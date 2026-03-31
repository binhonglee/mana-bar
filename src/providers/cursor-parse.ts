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
	const totalUsed = includedSpendCents / 100;
	const totalLimit = limitCents / 100;
	const hasAutoSpillover = pricing?.hasAutoSpillover === true;
	const autoPercentUsed = toFiniteNumber(planUsage.autoPercentUsed);
	const apiPercentUsed = toFiniteNumber(planUsage.apiPercentUsed);

	const quotaWindows: QuotaWindowUsage[] = [];
	if (hasAutoSpillover && autoPercentUsed !== null) {
		quotaWindows.push(toPercentWindow('Auto + Composer', autoPercentUsed, resetTime));
	}
	if (hasAutoSpillover && apiPercentUsed !== null) {
		quotaWindows.push(toPercentWindow('API', apiPercentUsed, resetTime));
	}

	return {
		serviceId: 'cursor',
		serviceName,
		totalUsed,
		totalLimit,
		resetTime,
		quotaWindows: quotaWindows.length > 0 ? quotaWindows : undefined,
		models: [],
		lastUpdated,
	};
}
