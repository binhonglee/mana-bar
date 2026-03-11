export function hasValidCache(expiresAt: number, now: number): boolean {
	return expiresAt > now;
}

export function getCachedValue<T>(value: T | null, expiresAt: number, now: number): T | null {
	return value !== null && hasValidCache(expiresAt, now) ? value : null;
}

export function getCacheExpiry(now: number, ttlMs: number): number {
	return now + ttlMs;
}

export async function withStaleFallback<T>(
	loadFreshValue: () => Promise<T>,
	staleValue: T,
	onError: (error: unknown) => void
): Promise<T> {
	try {
		return await loadFreshValue();
	} catch (error) {
		onError(error);
		return staleValue;
	}
}
