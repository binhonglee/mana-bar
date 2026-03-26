import { describe, expect, it, vi } from 'vitest';
import {
	getCacheExpiry,
	getCachedValue,
	hasValidCache,
	withStaleFallback,
} from '../../src/providers/cache';

describe('cache utilities', () => {
	describe('hasValidCache', () => {
		it('returns true when expiry is in the future', () => {
			const now = 1000;
			const expiresAt = 2000;
			expect(hasValidCache(expiresAt, now)).toBe(true);
		});

		it('returns false when expiry is in the past', () => {
			const now = 2000;
			const expiresAt = 1000;
			expect(hasValidCache(expiresAt, now)).toBe(false);
		});

		it('returns false when expiry equals now', () => {
			const now = 1000;
			const expiresAt = 1000;
			expect(hasValidCache(expiresAt, now)).toBe(false);
		});

		it('returns true when expiry is 1ms in the future', () => {
			const now = 1000;
			const expiresAt = 1001;
			expect(hasValidCache(expiresAt, now)).toBe(true);
		});
	});

	describe('getCachedValue', () => {
		it('returns value when cache is valid', () => {
			const value = { data: 'test' };
			const now = 1000;
			const expiresAt = 2000;
			expect(getCachedValue(value, expiresAt, now)).toBe(value);
		});

		it('returns null when cache is expired', () => {
			const value = { data: 'test' };
			const now = 2000;
			const expiresAt = 1000;
			expect(getCachedValue(value, expiresAt, now)).toBeNull();
		});

		it('returns null when value is null even if cache would be valid', () => {
			const now = 1000;
			const expiresAt = 2000;
			expect(getCachedValue(null, expiresAt, now)).toBeNull();
		});

		it('returns falsy values correctly when cache is valid', () => {
			const now = 1000;
			const expiresAt = 2000;
			expect(getCachedValue(0, expiresAt, now)).toBe(0);
			expect(getCachedValue('', expiresAt, now)).toBe('');
			expect(getCachedValue(false, expiresAt, now)).toBe(false);
		});
	});

	describe('getCacheExpiry', () => {
		it('returns now plus TTL', () => {
			const now = 1000;
			const ttlMs = 5000;
			expect(getCacheExpiry(now, ttlMs)).toBe(6000);
		});

		it('handles zero TTL', () => {
			const now = 1000;
			const ttlMs = 0;
			expect(getCacheExpiry(now, ttlMs)).toBe(1000);
		});

		it('handles large TTL values', () => {
			const now = 1000;
			const ttlMs = 86400000; // 24 hours
			expect(getCacheExpiry(now, ttlMs)).toBe(86401000);
		});
	});

	describe('withStaleFallback', () => {
		it('returns fresh value when load succeeds', async () => {
			const freshValue = { fresh: true };
			const staleValue = { stale: true };
			const onError = vi.fn();

			const result = await withStaleFallback(
				async () => freshValue,
				staleValue,
				onError
			);

			expect(result).toBe(freshValue);
			expect(onError).not.toHaveBeenCalled();
		});

		it('returns stale value and calls onError when load fails', async () => {
			const error = new Error('load failed');
			const staleValue = { stale: true };
			const onError = vi.fn();

			const result = await withStaleFallback(
				async () => {
					throw error;
				},
				staleValue,
				onError
			);

			expect(result).toBe(staleValue);
			expect(onError).toHaveBeenCalledWith(error);
		});

		it('handles async functions that reject', async () => {
			const staleValue = 'stale';
			const onError = vi.fn();

			const result = await withStaleFallback(
				() => Promise.reject(new Error('rejected')),
				staleValue,
				onError
			);

			expect(result).toBe(staleValue);
			expect(onError).toHaveBeenCalled();
		});

		it('handles null stale value', async () => {
			const onError = vi.fn();

			const result = await withStaleFallback(
				async () => {
					throw new Error('fail');
				},
				null,
				onError
			);

			expect(result).toBeNull();
			expect(onError).toHaveBeenCalled();
		});

		it('passes non-Error objects to onError', async () => {
			const staleValue = 'stale';
			const onError = vi.fn();
			const nonErrorObject = { code: 'CUSTOM_ERROR' };

			await withStaleFallback(
				async () => {
					throw nonErrorObject;
				},
				staleValue,
				onError
			);

			expect(onError).toHaveBeenCalledWith(nonErrorObject);
		});
	});
});
