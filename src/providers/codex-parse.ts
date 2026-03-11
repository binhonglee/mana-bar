import { QuotaWindowUsage, UsageData } from '../types';

/**
 * Codex app-server JSON-RPC response structures.
 */
export interface CodexRateLimitsResponse {
	id: number;
	result: {
		rateLimits: {
			primary: {
				usedPercent: number;
				windowDurationMins: number;
				resetsAt: number;
			};
			secondary?: {
				usedPercent: number;
				windowDurationMins: number;
				resetsAt: number;
			} | null;
		};
	};
}

export function formatCodexWindowLabel(windowDurationMins: number): string {
	const minutesPerHour = 60;
	const minutesPerDay = 24 * minutesPerHour;
	const minutesPerWeek = 7 * minutesPerDay;
	const tolerance = 5;

	const weeks = Math.round(windowDurationMins / minutesPerWeek);
	if (weeks >= 1 && Math.abs(windowDurationMins - weeks * minutesPerWeek) <= tolerance) {
		return `${weeks} Week${weeks === 1 ? '' : 's'}`;
	}

	const days = Math.round(windowDurationMins / minutesPerDay);
	if (days >= 1 && Math.abs(windowDurationMins - days * minutesPerDay) <= tolerance) {
		return `${days} Day${days === 1 ? '' : 's'}`;
	}

	const hours = Math.round(windowDurationMins / minutesPerHour);
	if (hours >= 1 && Math.abs(windowDurationMins - hours * minutesPerHour) <= tolerance) {
		return `${hours} Hour${hours === 1 ? '' : 's'}`;
	}

	return `${windowDurationMins} Min`;
}

export function parseCodexRateLimitsResponse(
	response: CodexRateLimitsResponse,
	serviceName = 'Codex',
	lastUpdated = new Date()
): UsageData {
	const { primary, secondary } = response.result.rateLimits;

	const primaryUtil = primary?.usedPercent || 0;
	const secondaryUtil = secondary?.usedPercent || 0;

	let useSecondary = secondaryUtil > primaryUtil;

	if (primaryUtil >= 95 && secondaryUtil >= 95 && secondary) {
		const primaryReset = new Date(primary.resetsAt * 1000);
		const secondaryReset = new Date(secondary.resetsAt * 1000);
		useSecondary = secondaryReset > primaryReset;
	}

	const selectedLimit = (useSecondary && secondary) ? secondary : primary;
	const totalUsed = Math.round(selectedLimit.usedPercent);
	const resetTime = new Date(selectedLimit.resetsAt * 1000);
	const quotaWindows: QuotaWindowUsage[] = [primary, secondary]
		.filter((limit): limit is NonNullable<typeof limit> => limit !== null && limit !== undefined)
		.map(limit => ({
			label: formatCodexWindowLabel(limit.windowDurationMins),
			used: Math.round(limit.usedPercent),
			limit: 100,
			resetTime: new Date(limit.resetsAt * 1000),
		}));

	return {
		serviceId: 'codex',
		serviceName,
		totalUsed,
		totalLimit: 100,
		resetTime,
		quotaWindows: quotaWindows.length > 0 ? quotaWindows : undefined,
		models: [],
		lastUpdated,
	};
}
