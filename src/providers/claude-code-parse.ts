import { QuotaWindowUsage, UsageData } from '../types';

/**
 * Anthropic OAuth usage API response.
 */
export interface AnthropicUsageResponse {
	five_hour?: {
		utilization: number;
		resets_at: string;
	};
	seven_day?: {
		utilization: number;
		resets_at: string;
	};
	extra_usage?: {
		is_enabled: boolean;
		monthly_limit: number;
		used_credits: number;
		utilization: number | null;
	};
}

export function parseClaudeUsageResponse(
	response: AnthropicUsageResponse,
	serviceName = 'Claude Code',
	lastUpdated = new Date()
): UsageData {
	const fiveHour = response.five_hour;
	const sevenDay = response.seven_day;

	const fiveHourUtil = fiveHour?.utilization || 0;
	const sevenDayUtil = sevenDay?.utilization || 0;

	let useSevenDay = sevenDayUtil > fiveHourUtil;

	// If both windows are nearly exhausted, prefer the longer cooldown.
	if (fiveHourUtil >= 95 && sevenDayUtil >= 95) {
		const fiveHourReset = fiveHour?.resets_at ? new Date(fiveHour.resets_at) : new Date(0);
		const sevenDayReset = sevenDay?.resets_at ? new Date(sevenDay.resets_at) : new Date(0);
		useSevenDay = sevenDayReset > fiveHourReset;
	}

	const totalUsed = Math.round(useSevenDay ? sevenDayUtil : fiveHourUtil);
	const totalLimit = 100;
	const resetTime = useSevenDay
		? (sevenDay?.resets_at ? new Date(sevenDay.resets_at) : undefined)
		: (fiveHour?.resets_at ? new Date(fiveHour.resets_at) : undefined);
	const quotaWindows: QuotaWindowUsage[] = [];

	if (fiveHour) {
		quotaWindows.push({
			label: '5 Hour',
			used: Math.round(fiveHourUtil),
			limit: 100,
			resetTime: fiveHour.resets_at ? new Date(fiveHour.resets_at) : undefined,
		});
	}

	if (sevenDay) {
		quotaWindows.push({
			label: '1 Week',
			used: Math.round(sevenDayUtil),
			limit: 100,
			resetTime: sevenDay.resets_at ? new Date(sevenDay.resets_at) : undefined,
		});
	}

	return {
		serviceId: 'claudeCode',
		serviceName,
		totalUsed,
		totalLimit,
		resetTime,
		quotaWindows: quotaWindows.length > 0 ? quotaWindows : undefined,
		models: [],
		lastUpdated,
	};
}
