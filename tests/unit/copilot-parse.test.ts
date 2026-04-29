import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CopilotParser } from '../../src/providers/copilot/parse';
import { createTestDeps, type TestDeps } from '../support/copilot-test-utils';
import type {
	CopilotResolvedQuotaBucket,
	CopilotEntitlementResponse,
} from '../../src/providers/copilot/types';

describe('CopilotParser', () => {
	let testDeps: TestDeps;
	let parser: CopilotParser;

	beforeEach(() => {
		testDeps = createTestDeps();
		parser = new CopilotParser(testDeps.deps, testDeps.logParseFailure);
	});

	afterEach(() => {
		testDeps = undefined!;
		parser = undefined!;
	});

	describe('normalizeAuthEntitlementResponse', () => {
		it('returns null for non-object input', () => {
			expect(parser.normalizeAuthEntitlementResponse(null, 'http://test')).toBeNull();
			expect(parser.normalizeAuthEntitlementResponse(undefined, 'http://test')).toBeNull();
			expect(parser.normalizeAuthEntitlementResponse('string', 'http://test')).toBeNull();
		});

		it('returns null when no buckets can be extracted', () => {
			expect(parser.normalizeAuthEntitlementResponse({}, 'http://test')).toBeNull();
		});

		it('normalizes a response with quota_snapshots premium_interactions', () => {
			const response = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: 200,
						percent_remaining: 75,
						overage_permitted: true,
						overage_count: 5,
					},
				},
				quota_reset_date_utc: '2026-03-10T18:00:00.000Z',
			};

			const result = parser.normalizeAuthEntitlementResponse(response, 'http://api.github.com');
			expect(result).not.toBeNull();
			expect(result!.quota).toBe(200);
			expect(result!.used).toBe(50); // 200 * (1 - 75/100) = 50
			expect(result!.resetDate).toEqual(new Date('2026-03-10T18:00:00.000Z'));
			expect(result!.surface).toBe('premium');
			expect(result!.source).toBe('auth-entitlement');
			expect(result!.overageEnabled).toBe(true);
			expect(result!.overageUsed).toBe(5);
			expect(result!.unlimited).toBe(false);
			expect(result!.detail).toContain('premium_interactions');
			expect(result!.observedAt).toBe(1_000_000);
		});

		it('normalizes a response with quota_snapshots chat bucket', () => {
			const response = {
				quota_snapshots: {
					chat: {
						entitlement: 100,
						percent_remaining: 60,
						overage_permitted: false,
						overage_count: 0,
					},
				},
				quota_reset_date: '2026-04-01T00:00:00.000Z',
			};

			const result = parser.normalizeAuthEntitlementResponse(response, 'http://api.github.com');
			expect(result).not.toBeNull();
			expect(result!.quota).toBe(100);
			expect(result!.used).toBe(40); // 100 * (1 - 60/100) = 40
			expect(result!.surface).toBe('chat');
		});

		it('uses limited_user_reset_date as fallback for resetDate', () => {
			const response = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: 50,
						percent_remaining: 100,
					},
				},
				limited_user_reset_date: '2026-05-01T00:00:00.000Z',
			};

			const result = parser.normalizeAuthEntitlementResponse(response, 'http://test');
			expect(result).not.toBeNull();
			expect(result!.resetDate).toEqual(new Date('2026-05-01T00:00:00.000Z'));
		});
	});

	describe('extractAuthBuckets', () => {
		it('extracts chat bucket from monthly_quotas and limited_user_quotas', () => {
			const payload: CopilotEntitlementResponse = {
				monthly_quotas: { chat: 100 },
				limited_user_quotas: { chat: 70 },
			};

			const buckets = parser.extractAuthBuckets(payload);
			expect(buckets).toHaveLength(1);
			expect(buckets[0].name).toBe('chat');
			expect(buckets[0].quota).toBe(100);
			expect(buckets[0].used).toBe(30); // 100 - 70
			expect(buckets[0].percentRemaining).toBeCloseTo(70);
		});

		it('extracts completions bucket from monthly_quotas and limited_user_quotas', () => {
			const payload: CopilotEntitlementResponse = {
				monthly_quotas: { completions: 500 },
				limited_user_quotas: { completions: 200 },
			};

			const buckets = parser.extractAuthBuckets(payload);
			expect(buckets).toHaveLength(1);
			expect(buckets[0].name).toBe('completions');
			expect(buckets[0].quota).toBe(500);
			expect(buckets[0].used).toBe(300); // 500 - 200
		});

		it('extracts both chat and completions buckets', () => {
			const payload: CopilotEntitlementResponse = {
				monthly_quotas: { chat: 100, completions: 500 },
				limited_user_quotas: { chat: 80, completions: 400 },
			};

			const buckets = parser.extractAuthBuckets(payload);
			expect(buckets).toHaveLength(2);
			expect(buckets[0].name).toBe('chat');
			expect(buckets[1].name).toBe('completions');
		});

		it('ignores buckets with total <= 0', () => {
			const payload: CopilotEntitlementResponse = {
				monthly_quotas: { chat: 0 },
				limited_user_quotas: { chat: 0 },
			};

			const buckets = parser.extractAuthBuckets(payload);
			expect(buckets).toHaveLength(0);
		});

		it('extracts buckets from quota_snapshots', () => {
			const payload: CopilotEntitlementResponse = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: 200,
						percent_remaining: 50,
						overage_permitted: true,
						overage_count: 3,
					},
					chat: {
						entitlement: 100,
						percent_remaining: 80,
						overage_permitted: false,
						overage_count: 0,
					},
				},
			};

			const buckets = parser.extractAuthBuckets(payload);
			expect(buckets).toHaveLength(2);
			const premium = buckets.find(b => b.name === 'premium_interactions')!;
			expect(premium.quota).toBe(200);
			expect(premium.used).toBe(100); // 200 - (200 * 50/100)
			expect(premium.overageEnabled).toBe(true);
			expect(premium.overageUsed).toBe(3);

			const chat = buckets.find(b => b.name === 'chat')!;
			expect(chat.quota).toBe(100);
			expect(chat.used).toBe(20); // 100 - (100 * 80/100)
		});

		it('uses explicit remaining when available in quota_snapshots', () => {
			const payload: CopilotEntitlementResponse = {
				quota_snapshots: {
					chat: {
						entitlement: 100,
						remaining: 65,
						percent_remaining: 60, // would give 60, but explicit remaining=65 takes priority
						overage_permitted: false,
						overage_count: 0,
					},
				},
			};

			const buckets = parser.extractAuthBuckets(payload);
			expect(buckets).toHaveLength(1);
			expect(buckets[0].used).toBe(35); // 100 - 65
		});
	});

	describe('pickAuthBucket', () => {
		it('returns null for empty array', () => {
			expect(parser.pickAuthBucket([])).toBeNull();
		});

		it('selects chat bucket when present among bounded buckets', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'premium_interactions', quota: 200, used: 50, percentRemaining: 75, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'chat', quota: 100, used: 30, percentRemaining: 70, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'completions', quota: 500, used: 100, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.pickAuthBucket(buckets);
			expect(result!.name).toBe('chat');
		});

		it('falls back to premium bucket when no chat bucket exists', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'premium_interactions', quota: 200, used: 50, percentRemaining: 75, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'completions', quota: 500, used: 100, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.pickAuthBucket(buckets);
			expect(result!.name).toBe('premium_interactions');
		});

		it('falls back to premium_models when no chat or premium_interactions', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'premium_models', quota: 150, used: 30, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'completions', quota: 500, used: 100, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.pickAuthBucket(buckets);
			expect(result!.name).toBe('premium_models');
		});

		it('selects lowest percentRemaining when no chat or premium bucket', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'completions', quota: 500, used: 400, percentRemaining: 20, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'completions', quota: 300, used: 60, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.pickAuthBucket(buckets);
			expect(result!.percentRemaining).toBe(20);
		});

		it('skips unlimited buckets for priority selection', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'chat', quota: 100, used: 30, percentRemaining: 70, overageEnabled: false, overageUsed: 0, unlimited: true },
				{ name: 'premium_interactions', quota: 200, used: 50, percentRemaining: 75, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.pickAuthBucket(buckets);
			expect(result!.name).toBe('premium_interactions');
		});

		it('falls back to unlimited bucket when all are unlimited', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'premium_interactions', quota: -1, used: 0, percentRemaining: 100, overageEnabled: false, overageUsed: 0, unlimited: true },
				{ name: 'chat', quota: -1, used: 0, percentRemaining: 100, overageEnabled: false, overageUsed: 0, unlimited: true },
			];

			const result = parser.pickAuthBucket(buckets);
			expect(result).not.toBeNull();
			// Falls back to premium_interactions or chat from the unfiltered list
			expect(result!.name).toBe('premium_interactions');
		});
	});

	describe('buildAuthQuotaWindows', () => {
		it('returns undefined for empty buckets', () => {
			expect(parser.buildAuthQuotaWindows([])).toBeUndefined();
		});

		it('returns undefined when all buckets are unlimited', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'chat', quota: -1, used: 0, percentRemaining: 100, overageEnabled: false, overageUsed: 0, unlimited: true },
			];
			expect(parser.buildAuthQuotaWindows(buckets)).toBeUndefined();
		});

		it('returns windows sorted with chat before completions', () => {
			const resetDate = new Date('2026-03-10T18:00:00.000Z');
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'completions', quota: 500, used: 100.7, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'chat', quota: 100, used: 30.3, percentRemaining: 70, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const windows = parser.buildAuthQuotaWindows(buckets, resetDate);
			expect(windows).toHaveLength(2);
			expect(windows![0].label).toBe('Chat messages');
			expect(windows![0].used).toBe(30);
			expect(windows![0].limit).toBe(100);
			expect(windows![0].resetTime).toEqual(resetDate);
			expect(windows![1].label).toBe('Inline suggestions');
			expect(windows![1].used).toBe(101);
			expect(windows![1].limit).toBe(500);
		});

		it('filters out premium and unlimited buckets from windows', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'premium_interactions', quota: 200, used: 50, percentRemaining: 75, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'chat', quota: 100, used: 30, percentRemaining: 70, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const windows = parser.buildAuthQuotaWindows(buckets);
			expect(windows).toHaveLength(1);
			expect(windows![0].label).toBe('Chat messages');
		});
	});

	describe('parseQuotaHeader', () => {
		it('parses a valid quota header string', () => {
			const raw = 'ent=100&rem=60&rst=2026-03-10T18%3A00%3A00.000Z&ovPerm=true&ov=5';
			const result = parser.parseQuotaHeader(
				'x-quota-snapshot-premium_interactions',
				raw,
				'fetch',
				'premium',
				'http://api.github.com'
			);

			expect(result).not.toBeNull();
			expect(result!.quota).toBe(100);
			expect(result!.used).toBe(40); // 100 * (1 - 60/100)
			expect(result!.resetDate).toEqual(new Date('2026-03-10T18:00:00.000Z'));
			expect(result!.overageEnabled).toBe(true);
			expect(result!.overageUsed).toBe(5);
			expect(result!.unlimited).toBe(false);
			expect(result!.surface).toBe('premium');
			expect(result!.source).toBe('fetch');
		});

		it('returns null when ent is missing', () => {
			const raw = 'rem=60&rst=2026-03-10T18%3A00%3A00.000Z';
			const result = parser.parseQuotaHeader(
				'x-quota-snapshot-chat',
				raw,
				'fetch',
				'chat',
				'http://test'
			);
			expect(result).toBeNull();
		});

		it('returns null when rem is missing', () => {
			const raw = 'ent=100&rst=2026-03-10T18%3A00%3A00.000Z';
			const result = parser.parseQuotaHeader(
				'x-quota-snapshot-chat',
				raw,
				'fetch',
				'chat',
				'http://test'
			);
			expect(result).toBeNull();
		});

		it('handles quota of -1 as unlimited', () => {
			const raw = 'ent=-1&rem=100';
			const result = parser.parseQuotaHeader(
				'x-quota-snapshot-chat',
				raw,
				'fetch',
				'chat',
				'http://test'
			);
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
			expect(result!.quota).toBe(-1);
		});

		it('handles missing resetDate gracefully', () => {
			const raw = 'ent=50&rem=80';
			const result = parser.parseQuotaHeader(
				'x-quota-snapshot-chat',
				raw,
				'fetch',
				'chat',
				'http://test'
			);
			expect(result).not.toBeNull();
			expect(result!.resetDate).toBeUndefined();
		});
	});

	describe('normalizeQuotaInfoValue', () => {
		it('normalizes a value with quotaInfo property', () => {
			const value = {
				quotaInfo: {
					quota: 120,
					used: 35,
					resetDate: '2026-03-10T18:00:00.000Z',
					overageEnabled: true,
					overageUsed: 2,
				},
			};

			const result = parser.normalizeQuotaInfoValue(value, 'test-detail', 'export-probe', 'chat');
			expect(result).not.toBeNull();
			expect(result!.quota).toBe(120);
			expect(result!.used).toBe(35);
			expect(result!.resetDate).toEqual(new Date('2026-03-10T18:00:00.000Z'));
			expect(result!.overageEnabled).toBe(true);
			expect(result!.overageUsed).toBe(2);
			expect(result!.surface).toBe('chat');
			expect(result!.source).toBe('export-probe');
		});

		it('normalizes a value with direct quota/used fields', () => {
			const value = {
				quota: 80,
				used: 20,
				resetDate: '2026-04-01T00:00:00.000Z',
			};

			const result = parser.normalizeQuotaInfoValue(value, 'test', 'export-probe', 'completions');
			expect(result).not.toBeNull();
			expect(result!.quota).toBe(80);
			expect(result!.used).toBe(20);
		});

		it('returns null for non-object input', () => {
			expect(parser.normalizeQuotaInfoValue(null, 'test', 'export-probe', 'chat')).toBeNull();
			expect(parser.normalizeQuotaInfoValue(42, 'test', 'export-probe', 'chat')).toBeNull();
		});

		it('returns null when quota or used is not finite', () => {
			const value = { quota: Infinity, used: 10 };
			expect(parser.normalizeQuotaInfoValue(value, 'test', 'export-probe', 'chat')).toBeNull();
		});

		it('marks unlimited when quota is -1', () => {
			const value = { quotaInfo: { quota: -1, used: 0 } };
			const result = parser.normalizeQuotaInfoValue(value, 'test', 'export-probe', 'chat');
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
		});

		it('marks unlimited when unlimited flag is true', () => {
			const value = { quotaInfo: { quota: 100, used: 0, unlimited: true } };
			const result = parser.normalizeQuotaInfoValue(value, 'test', 'export-probe', 'chat');
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
		});
	});

	describe('normalizeQuotaSnapshotsValue', () => {
		it('normalizes a value with quota_snapshots and quota_reset_date', () => {
			const value = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: 200,
						percent_remaining: 75,
						overage_permitted: true,
						overage_count: 3,
					},
				},
				quota_reset_date: '2026-03-10T18:00:00.000Z',
			};

			const result = parser.normalizeQuotaSnapshotsValue(value, 'test-detail', 'export-probe', 'premium');
			expect(result).not.toBeNull();
			expect(result!.quota).toBe(200);
			expect(result!.used).toBe(50); // 200 * (1 - 75/100)
			expect(result!.resetDate).toEqual(new Date('2026-03-10T18:00:00.000Z'));
			expect(result!.overageEnabled).toBe(true);
			expect(result!.overageUsed).toBe(3);
		});

		it('returns null for non-object input', () => {
			expect(parser.normalizeQuotaSnapshotsValue(null, 'test', 'export-probe', 'chat')).toBeNull();
		});

		it('returns null when quota_snapshots is missing', () => {
			const value = { quota_reset_date: '2026-01-01' };
			expect(parser.normalizeQuotaSnapshotsValue(value, 'test', 'export-probe', 'chat')).toBeNull();
		});

		it('returns null when quota_reset_date is missing', () => {
			const value = { quota_snapshots: { chat: { entitlement: 100, percent_remaining: 50 } } };
			expect(parser.normalizeQuotaSnapshotsValue(value, 'test', 'export-probe', 'chat')).toBeNull();
		});

		it('marks unlimited when entitlement is -1', () => {
			const value = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: -1,
						percent_remaining: 100,
					},
				},
				quota_reset_date: '2026-01-01',
			};

			const result = parser.normalizeQuotaSnapshotsValue(value, 'test', 'export-probe', 'premium');
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
		});

		it('marks unlimited when unlimited flag is true', () => {
			const value = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: 100,
						percent_remaining: 100,
						unlimited: true,
					},
				},
				quota_reset_date: '2026-01-01',
			};

			const result = parser.normalizeQuotaSnapshotsValue(value, 'test', 'export-probe', 'premium');
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
		});
	});

	describe('unlimited detection', () => {
		it('detects unlimited from quota_snapshots with unlimited: true', () => {
			const response = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: 200,
						percent_remaining: 100,
						unlimited: true,
					},
				},
			};

			const result = parser.normalizeAuthEntitlementResponse(response, 'http://test');
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
		});

		it('detects unlimited from quota: -1', () => {
			const response = {
				quota_snapshots: {
					premium_interactions: {
						entitlement: -1,
						percent_remaining: 100,
					},
				},
			};

			const result = parser.normalizeAuthEntitlementResponse(response, 'http://test');
			expect(result).not.toBeNull();
			expect(result!.unlimited).toBe(true);
		});
	});

	describe('describeAuthBuckets', () => {
		it('formats a single bucket', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'chat', quota: 100, used: 30.4, percentRemaining: 70, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.describeAuthBuckets(buckets);
			expect(result).toBe('chat:30/100:70%');
		});

		it('formats multiple buckets separated by commas', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'chat', quota: 100, used: 30, percentRemaining: 70, overageEnabled: false, overageUsed: 0, unlimited: false },
				{ name: 'completions', quota: 500, used: 100, percentRemaining: 80, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.describeAuthBuckets(buckets);
			expect(result).toBe('chat:30/100:70%, completions:100/500:80%');
		});

		it('rounds used, quota, and percentRemaining', () => {
			const buckets: CopilotResolvedQuotaBucket[] = [
				{ name: 'premium_interactions', quota: 199.7, used: 49.6, percentRemaining: 75.3, overageEnabled: false, overageUsed: 0, unlimited: false },
			];

			const result = parser.describeAuthBuckets(buckets);
			expect(result).toBe('premium_interactions:50/200:75%');
		});
	});

	describe('Property-based tests', () => {
		/**
		 * Property 1: Entitlement response normalization preserves quota arithmetic
		 * For any valid entitlement response containing quota_snapshots with a premium_interactions
		 * bucket having finite entitlement E and percent_remaining P,
		 * normalizeAuthEntitlementResponse SHALL return a snapshot where
		 * quota === E and used === max(0, E * (1 - P/100)).
		 *
		 * **Validates: Requirements 1.1**
		 */
		it('Property 1: entitlement response normalization preserves quota arithmetic', () => {
			fc.assert(
				fc.property(
					fc.float({ min: 1, max: 100000, noNaN: true }),
					fc.float({ min: 0, max: 100, noNaN: true }),
					(entitlement, percentRemaining) => {
						const response = {
							quota_snapshots: {
								premium_interactions: {
									entitlement,
									percent_remaining: percentRemaining,
								},
							},
						};

						const result = parser.normalizeAuthEntitlementResponse(response, 'http://test');
						expect(result).not.toBeNull();
						expect(result!.quota).toBe(entitlement);
						const expectedUsed = Math.max(0, entitlement * (1 - percentRemaining / 100));
						expect(result!.used).toBeCloseTo(expectedUsed, 5);
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 2: Bucket extraction correctly derives used from total and remaining
		 * For any entitlement response with monthly_quotas.chat = T and limited_user_quotas.chat = R
		 * where T > 0 and 0 <= R <= T, extractAuthBuckets SHALL return a chat bucket where
		 * quota === T and used === T - R.
		 *
		 * **Validates: Requirements 1.2**
		 */
		it('Property 2: bucket extraction correctly derives used from total and remaining', () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1, max: 100000 }),
					fc.float({ min: 0, max: 1, noNaN: true }),
					(total, fraction) => {
						const remaining = Math.floor(total * fraction);
						const payload: CopilotEntitlementResponse = {
							monthly_quotas: { chat: total },
							limited_user_quotas: { chat: remaining },
						};

						const buckets = parser.extractAuthBuckets(payload);
						const chatBucket = buckets.find(b => b.name === 'chat');
						expect(chatBucket).toBeDefined();
						expect(chatBucket!.quota).toBe(total);
						expect(chatBucket!.used).toBe(total - remaining);
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 3: Bucket selection priority (chat > premium > lowest percentRemaining)
		 * For any non-empty array of CopilotResolvedQuotaBucket entries, pickAuthBucket SHALL select:
		 * (1) the bounded chat bucket if one exists, else
		 * (2) a bounded premium bucket if one exists, else
		 * (3) the bounded bucket with the lowest percentRemaining.
		 *
		 * **Validates: Requirements 1.3**
		 */
		it('Property 3: bucket selection priority', () => {
			const bucketNameArb = fc.constantFrom<CopilotResolvedQuotaBucket['name']>(
				'chat', 'completions', 'premium_interactions', 'premium_models'
			);

			const boundedBucketArb = fc.record({
				name: bucketNameArb,
				quota: fc.integer({ min: 1, max: 10000 }),
				used: fc.integer({ min: 0, max: 10000 }),
				percentRemaining: fc.float({ min: 0, max: 100, noNaN: true }),
				overageEnabled: fc.boolean(),
				overageUsed: fc.integer({ min: 0, max: 100 }),
				unlimited: fc.constant(false),
			}) as fc.Arbitrary<CopilotResolvedQuotaBucket>;

			fc.assert(
				fc.property(
					fc.array(boundedBucketArb, { minLength: 1, maxLength: 6 }),
					(buckets) => {
						const result = parser.pickAuthBucket(buckets);
						expect(result).not.toBeNull();

						const bounded = buckets.filter(b => !b.unlimited && b.quota > 0);
						if (bounded.length === 0) {
							// Falls back to any bucket
							return;
						}

						const chatBucket = bounded.find(b => b.name === 'chat');
						if (chatBucket) {
							expect(result!.name).toBe('chat');
							return;
						}

						const premiumBucket = bounded.find(b =>
							b.name === 'premium_interactions' || b.name === 'premium_models'
						);
						if (premiumBucket) {
							expect(
								result!.name === 'premium_interactions' || result!.name === 'premium_models'
							).toBe(true);
							return;
						}

						// Should be the one with lowest percentRemaining
						const lowestPR = bounded.reduce((min, b) =>
							b.percentRemaining < min.percentRemaining ? b : min
						);
						expect(result!.percentRemaining).toBe(lowestPR.percentRemaining);
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 4: Quota windows sort order
		 * For any array of bounded chat and completions buckets, buildAuthQuotaWindows SHALL return
		 * windows sorted with chat (label "Chat messages") before completions (label "Inline suggestions"),
		 * each with used === round(bucket.used) and limit === round(bucket.quota).
		 *
		 * **Validates: Requirements 1.4**
		 */
		it('Property 4: quota windows sort order', () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1, max: 10000 }),
					fc.integer({ min: 0, max: 10000 }),
					fc.integer({ min: 1, max: 10000 }),
					fc.integer({ min: 0, max: 10000 }),
					(chatQuota, chatUsed, compQuota, compUsed) => {
						const buckets: CopilotResolvedQuotaBucket[] = [
							{ name: 'completions', quota: compQuota, used: compUsed, percentRemaining: 50, overageEnabled: false, overageUsed: 0, unlimited: false },
							{ name: 'chat', quota: chatQuota, used: chatUsed, percentRemaining: 50, overageEnabled: false, overageUsed: 0, unlimited: false },
						];

						const windows = parser.buildAuthQuotaWindows(buckets);
						expect(windows).toBeDefined();
						expect(windows).toHaveLength(2);
						expect(windows![0].label).toBe('Chat messages');
						expect(windows![0].used).toBe(Math.round(chatUsed));
						expect(windows![0].limit).toBe(Math.round(chatQuota));
						expect(windows![1].label).toBe('Inline suggestions');
						expect(windows![1].used).toBe(Math.round(compUsed));
						expect(windows![1].limit).toBe(Math.round(compQuota));
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 5: Quota header parsing round-trip
		 * For any valid quota header string with ent=E&rem=P where E and P are finite numbers,
		 * parseQuotaHeader SHALL return a snapshot where quota === E,
		 * used === max(0, E * (1 - P/100)), and unlimited === (E === -1).
		 *
		 * **Validates: Requirements 1.5**
		 */
		it('Property 5: quota header parsing round-trip', () => {
			fc.assert(
				fc.property(
					fc.float({ min: 1, max: 100000, noNaN: true }),
					fc.float({ min: 0, max: 100, noNaN: true }),
					(ent, rem) => {
						const raw = `ent=${ent}&rem=${rem}`;
						const result = parser.parseQuotaHeader(
							'x-quota-snapshot-chat',
							raw,
							'fetch',
							'chat',
							'http://test'
						);

						expect(result).not.toBeNull();
						expect(result!.quota).toBe(ent);
						const expectedUsed = Math.max(0, ent * (1 - rem / 100));
						expect(result!.used).toBeCloseTo(expectedUsed, 5);
						expect(result!.unlimited).toBe(ent === -1);
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 6: QuotaInfo normalization preserves values
		 * For any object containing quotaInfo with finite quota Q and used U,
		 * normalizeQuotaInfoValue SHALL return a snapshot where quota === Q and used === U.
		 *
		 * **Validates: Requirements 1.7**
		 */
		it('Property 6: quotaInfo normalization preserves values', () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 0, max: 100000 }),
					fc.integer({ min: 0, max: 100000 }),
					(quota, used) => {
						const value = { quotaInfo: { quota, used } };
						const result = parser.normalizeQuotaInfoValue(value, 'test', 'export-probe', 'chat');

						expect(result).not.toBeNull();
						expect(result!.quota).toBe(quota);
						expect(result!.used).toBe(used);
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 7: QuotaSnapshots normalization derives used from entitlement and percent_remaining
		 * For any object with quota_snapshots containing a priority bucket with finite entitlement E
		 * and percent_remaining P, normalizeQuotaSnapshotsValue SHALL return a snapshot where
		 * quota === E and used === max(0, E * (1 - P/100)).
		 *
		 * **Validates: Requirements 1.8**
		 */
		it('Property 7: quotaSnapshots normalization derives used from entitlement and percent_remaining', () => {
			fc.assert(
				fc.property(
					fc.float({ min: 1, max: 100000, noNaN: true }),
					fc.float({ min: 0, max: 100, noNaN: true }),
					(entitlement, percentRemaining) => {
						const value = {
							quota_snapshots: {
								premium_interactions: {
									entitlement,
									percent_remaining: percentRemaining,
								},
							},
							quota_reset_date: '2026-01-01T00:00:00.000Z',
						};

						const result = parser.normalizeQuotaSnapshotsValue(value, 'test', 'export-probe', 'premium');
						expect(result).not.toBeNull();
						expect(result!.quota).toBe(entitlement);
						const expectedUsed = Math.max(0, entitlement * (1 - percentRemaining / 100));
						expect(result!.used).toBeCloseTo(expectedUsed, 5);
					}
				),
				{ numRuns: 100 }
			);
		});

		/**
		 * Property 8: describeAuthBuckets includes all bucket information
		 * For any non-empty array of CopilotResolvedQuotaBucket, describeAuthBuckets SHALL produce
		 * a string containing each bucket's name, round(used)/round(quota), and round(percentRemaining)%.
		 *
		 * **Validates: Requirements 1.10**
		 */
		it('Property 8: describeAuthBuckets includes all bucket information', () => {
			const bucketNameArb = fc.constantFrom<CopilotResolvedQuotaBucket['name']>(
				'chat', 'completions', 'premium_interactions', 'premium_models'
			);

			const bucketArb = fc.record({
				name: bucketNameArb,
				quota: fc.integer({ min: 0, max: 10000 }),
				used: fc.integer({ min: 0, max: 10000 }),
				percentRemaining: fc.integer({ min: 0, max: 100 }),
				overageEnabled: fc.boolean(),
				overageUsed: fc.integer({ min: 0, max: 100 }),
				unlimited: fc.boolean(),
			}) as fc.Arbitrary<CopilotResolvedQuotaBucket>;

			fc.assert(
				fc.property(
					fc.array(bucketArb, { minLength: 1, maxLength: 5 }),
					(buckets) => {
						const result = parser.describeAuthBuckets(buckets);

						for (const bucket of buckets) {
							expect(result).toContain(bucket.name);
							expect(result).toContain(`${Math.round(bucket.used)}/${Math.round(bucket.quota)}`);
							expect(result).toContain(`${Math.round(bucket.percentRemaining)}%`);
						}
					}
				),
				{ numRuns: 100 }
			);
		});
	});
});
