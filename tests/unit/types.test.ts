import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getUsageStatus, SERVICE_IDS, UsageStatus } from '../../src/types';

describe('Core types module', () => {
	describe('getUsageStatus', () => {
		describe('OK threshold', () => {
			it('returns OK when used is 0% of limit', () => {
				expect(getUsageStatus(0, 100)).toBe(UsageStatus.OK);
			});

			it('returns OK when used is 50% of limit', () => {
				expect(getUsageStatus(50, 100)).toBe(UsageStatus.OK);
			});

			it('returns OK when used is just below 80% of limit', () => {
				expect(getUsageStatus(79, 100)).toBe(UsageStatus.OK);
			});
		});

		describe('WARNING threshold', () => {
			it('returns WARNING when used is exactly 80% of limit', () => {
				expect(getUsageStatus(80, 100)).toBe(UsageStatus.WARNING);
			});

			it('returns WARNING when used is 90% of limit', () => {
				expect(getUsageStatus(90, 100)).toBe(UsageStatus.WARNING);
			});

			it('returns WARNING when used is just below 100% of limit', () => {
				expect(getUsageStatus(99, 100)).toBe(UsageStatus.WARNING);
			});
		});

		describe('CRITICAL threshold', () => {
			it('returns CRITICAL when used equals limit', () => {
				expect(getUsageStatus(100, 100)).toBe(UsageStatus.CRITICAL);
			});

			it('returns CRITICAL when used exceeds limit', () => {
				expect(getUsageStatus(150, 100)).toBe(UsageStatus.CRITICAL);
			});
		});

		describe('limit=0 edge case', () => {
			it('returns CRITICAL when limit is 0', () => {
				expect(getUsageStatus(0, 0)).toBe(UsageStatus.CRITICAL);
			});

			it('returns CRITICAL when limit is 0 and used is positive', () => {
				expect(getUsageStatus(50, 0)).toBe(UsageStatus.CRITICAL);
			});
		});
	});

	describe('SERVICE_IDS', () => {
		it('contains exactly 8 service identifiers', () => {
			expect(SERVICE_IDS).toHaveLength(8);
		});

		it('contains all expected service identifiers', () => {
			expect(SERVICE_IDS).toContain('claudeCode');
			expect(SERVICE_IDS).toContain('codex');
			expect(SERVICE_IDS).toContain('vscodeCopilot');
			expect(SERVICE_IDS).toContain('copilotCli');
			expect(SERVICE_IDS).toContain('cursor');
			expect(SERVICE_IDS).toContain('antigravity');
			expect(SERVICE_IDS).toContain('gemini');
			expect(SERVICE_IDS).toContain('kiro');
		});
	});

	describe('UsageStatus enum', () => {
		it('has OK value', () => {
			expect(UsageStatus.OK).toBe('ok');
		});

		it('has WARNING value', () => {
			expect(UsageStatus.WARNING).toBe('warning');
		});

		it('has CRITICAL value', () => {
			expect(UsageStatus.CRITICAL).toBe('critical');
		});
	});

	describe('Property-based tests', () => {
		/**
		 * Property 9: getUsageStatus correctly classifies usage percentages
		 * For any used and limit where limit > 0, getUsageStatus SHALL return OK when
		 * used/limit < 0.8, WARNING when 0.8 <= used/limit < 1.0, and CRITICAL when
		 * used/limit >= 1.0.
		 *
		 * **Validates: Requirements 8.1, 8.2, 8.3**
		 */
		it('Property 9: getUsageStatus correctly classifies usage percentages', () => {
			fc.assert(
				fc.property(
					fc.float({ min: Math.fround(0), max: Math.fround(100000), noNaN: true }),
					fc.float({ min: Math.fround(0.01), max: Math.fround(100000), noNaN: true }),
					(used, limit) => {
						const result = getUsageStatus(used, limit);
						const ratio = used / limit;

						if (ratio >= 1.0) {
							expect(result).toBe(UsageStatus.CRITICAL);
						} else if (ratio >= 0.8) {
							expect(result).toBe(UsageStatus.WARNING);
						} else {
							expect(result).toBe(UsageStatus.OK);
						}
					}
				),
				{ numRuns: 100 }
			);
		});
	});
});
