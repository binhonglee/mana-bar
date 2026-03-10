import { UsageDisplayMode } from './types';

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

export function getRemainingValue(used: number, limit: number): number {
	return Math.max(0, limit - used);
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
	return limit === 100 ? `${value}%` : `${value}/${limit}`;
}

export function getDisplayModeLabel(mode: UsageDisplayMode): string {
	return mode === 'remaining' ? 'Left' : 'Usage';
}

export function getDisplayModeVerb(mode: UsageDisplayMode): string {
	return mode === 'remaining' ? 'left' : 'used';
}
