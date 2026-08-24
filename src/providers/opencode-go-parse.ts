import { QuotaWindowUsage, UsageData } from '../types';

/**
 * Response shape of the OpenCode Go usage endpoint.
 *
 * The endpoint reports one entry per quota window. Each entry gives the used
 * percentage and the time when the window resets. The set of windows can
 * change, so treat every window as optional.
 */
export interface OpenCodeGoUsageWindow {
	status: string;
	percent: number;
	resetsAt: string;
}

export interface OpenCodeGoUsageResponse {
	usage: {
		rolling?: OpenCodeGoUsageWindow | null;
		weekly?: OpenCodeGoUsageWindow | null;
		monthly?: OpenCodeGoUsageWindow | null;
	};
}

/**
 * Order and labels of the known quota windows. The parser keeps this order so
 * the UI shows the windows from shortest to longest.
 */
const WINDOW_LABELS: { key: keyof OpenCodeGoUsageResponse['usage']; label: string }[] = [
	{ key: 'rolling', label: 'Rolling' },
	{ key: 'weekly', label: 'Weekly' },
	{ key: 'monthly', label: 'Monthly' },
];

/**
 * A quota window with the raw (un-rounded) percentage kept for selection. The
 * raw value drives the most-constraining comparison so two values in the same
 * rounded bucket do not become a false tie.
 */
interface ParsedWindow {
	label: string;
	rawPercent: number;
	resetTime?: Date;
}

/**
 * Whether a window carries a usable percentage. Both the parser and
 * findBlockedWindow gate on this so health can never reference a window the
 * card dropped.
 */
function hasUsablePercent(
	window: OpenCodeGoUsageWindow | null | undefined
): window is OpenCodeGoUsageWindow {
	return !!window && Number.isFinite(window.percent);
}

function toParsedWindow(
	window: OpenCodeGoUsageWindow | null | undefined,
	label: string
): ParsedWindow | null {
	if (!hasUsablePercent(window)) {
		return null;
	}

	const rawPercent = Math.min(100, Math.max(0, window.percent));
	const resetTime = window.resetsAt ? new Date(window.resetsAt) : undefined;
	return {
		label,
		rawPercent,
		resetTime: resetTime && !Number.isNaN(resetTime.getTime()) ? resetTime : undefined,
	};
}

/**
 * Convert the OpenCode Go usage response into the shared UsageData shape.
 *
 * The values are percentages, so each window uses a limit of 100. The total
 * uses the most-constraining window, which is the window with the highest used
 * percentage. A tie selects the window that resets later, because that window
 * keeps the account blocked for longer. Percentages are compared raw and only
 * rounded when the window is built for display.
 */
export function parseOpenCodeGoUsageResponse(
	response: OpenCodeGoUsageResponse,
	serviceName = 'OpenCode Go',
	lastUpdated = new Date()
): UsageData {
	const parsedWindows: ParsedWindow[] = [];
	for (const { key, label } of WINDOW_LABELS) {
		const window = toParsedWindow(response.usage?.[key], label);
		if (window) {
			parsedWindows.push(window);
		}
	}

	let selected: ParsedWindow | undefined;
	for (const window of parsedWindows) {
		if (!selected) {
			selected = window;
			continue;
		}
		if (window.rawPercent > selected.rawPercent) {
			selected = window;
			continue;
		}
		if (window.rawPercent === selected.rawPercent && window.resetTime && selected.resetTime && window.resetTime > selected.resetTime) {
			selected = window;
		}
	}

	const quotaWindows: QuotaWindowUsage[] = parsedWindows.map((window) => ({
		label: window.label,
		used: Math.round(window.rawPercent),
		limit: 100,
		resetTime: window.resetTime,
	}));

	return {
		serviceId: 'opencodeGo',
		serviceName,
		totalUsed: selected ? Math.round(selected.rawPercent) : 0,
		totalLimit: 100,
		resetTime: selected?.resetTime,
		quotaWindows: quotaWindows.length > 0 ? quotaWindows : undefined,
		models: [],
		lastUpdated,
	};
}

/**
 * Find the first quota window that reports a status other than "ok". A blocked
 * window means the account hit a limit, so the caller can raise a rate-limited
 * health state even when the percentage stays below 100. The comparison is
 * case-insensitive.
 */
export function findBlockedWindow(
	response: OpenCodeGoUsageResponse
): { label: string; status: string } | null {
	for (const { key, label } of WINDOW_LABELS) {
		const window = response.usage?.[key];
		// Only consider windows the parser also keeps. Otherwise a dropped window
		// could raise health for a window absent from the card.
		if (
			hasUsablePercent(window) &&
			typeof window.status === 'string' &&
			window.status.toLowerCase() !== 'ok'
		) {
			return { label, status: window.status };
		}
	}
	return null;
}
