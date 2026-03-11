import {
	CopilotResolvedBucketName,
	CopilotResolvedQuotaBucket,
	CopilotEntitlementResponse,
	CopilotQuotaSnapshot,
	CopilotQuotaInfoLike,
	CopilotQuotaSnapshotBucket,
	CopilotQuotaHeaderName,
	CopilotSignalSource,
	CopilotSurface,
	ResolvedCopilotProviderDeps
} from './types';
import { toFiniteNumber, toDate, classifySurfaceFromBucketName, isRecord } from './utils';
import { QuotaWindowUsage } from '../types';

export class CopilotParser {
	constructor(
		private readonly deps: ResolvedCopilotProviderDeps,
		private readonly logParseFailure: (key: string, message: string) => void
	) { }

	normalizeAuthEntitlementResponse(value: unknown, url: string): CopilotQuotaSnapshot | null {
		if (!isRecord(value)) {
			return null;
		}

		const payload = value as CopilotEntitlementResponse;
		const buckets = this.extractAuthBuckets(payload);
		if (buckets.length === 0) {
			return null;
		}

		const selectedBucket = this.pickAuthBucket(buckets);
		if (!selectedBucket) {
			return null;
		}

		const resetDate = toDate(
			payload.quota_reset_date_utc
			?? payload.quota_reset_date
			?? payload.limited_user_reset_date
		);

		return {
			quota: selectedBucket.quota,
			used: selectedBucket.used,
			resetDate,
			quotaWindows: this.buildAuthQuotaWindows(buckets, resetDate),
			overageEnabled: selectedBucket.overageEnabled,
			overageUsed: selectedBucket.overageUsed,
			unlimited: selectedBucket.unlimited || selectedBucket.quota === -1,
			surface: classifySurfaceFromBucketName(selectedBucket.name),
			source: 'auth-entitlement',
			detail: `${url} (${selectedBucket.name})`,
			observedAt: this.deps.now(),
		};
	}

	extractAuthBuckets(payload: CopilotEntitlementResponse): CopilotResolvedQuotaBucket[] {
		const buckets: CopilotResolvedQuotaBucket[] = [];

		const pushLimitedBucket = (name: 'chat' | 'completions', totalValue: unknown, remainingValue: unknown): void => {
			const total = toFiniteNumber(totalValue);
			const remaining = toFiniteNumber(remainingValue);
			if (total === null || remaining === null || total <= 0) {
				return;
			}

			const percentRemaining = Math.max(0, Math.min(100, (remaining / total) * 100));
			buckets.push({
				name,
				quota: total,
				used: Math.max(0, total - remaining),
				percentRemaining,
				overageEnabled: false,
				overageUsed: 0,
				unlimited: false,
			});
		};

		pushLimitedBucket(
			'chat',
			payload.monthly_quotas?.chat,
			payload.limited_user_quotas?.chat
		);
		pushLimitedBucket(
			'completions',
			payload.monthly_quotas?.completions,
			payload.limited_user_quotas?.completions
		);

		const snapshotBuckets = payload.quota_snapshots;
		if (isRecord(snapshotBuckets)) {
			const bucketNames: CopilotResolvedBucketName[] = ['premium_interactions', 'premium_models', 'chat', 'completions'];
			for (const name of bucketNames) {
				const bucket = snapshotBuckets[name];
				if (!isRecord(bucket)) {
					continue;
				}

				const quota = toFiniteNumber(bucket.entitlement);
				const percentRemaining = toFiniteNumber(bucket.percent_remaining);
				if (quota === null || percentRemaining === null) {
					continue;
				}

				const explicitRemaining = toFiniteNumber(bucket.remaining);
				const remaining = explicitRemaining ?? Math.max(0, quota * (percentRemaining / 100));
				buckets.push({
					name,
					quota,
					used: Math.max(0, quota - remaining),
					percentRemaining: Math.max(0, Math.min(100, percentRemaining)),
					overageEnabled: Boolean(bucket.overage_permitted),
					overageUsed: toFiniteNumber(bucket.overage_count) ?? 0,
					unlimited: Boolean(bucket.unlimited) || quota === -1,
				});
			}
		}

		return buckets;
	}

	pickAuthBucket(buckets: CopilotResolvedQuotaBucket[]): CopilotResolvedQuotaBucket | null {
		const boundedBuckets = buckets.filter(bucket => !bucket.unlimited && bucket.quota > 0);
		const chatBucket = boundedBuckets.find(bucket => bucket.name === 'chat');
		if (chatBucket) {
			return chatBucket;
		}

		const premiumBoundedBucket = boundedBuckets.find(bucket =>
			bucket.name === 'premium_interactions' || bucket.name === 'premium_models'
		);

		if (premiumBoundedBucket) {
			return premiumBoundedBucket;
		}

		if (boundedBuckets.length > 0) {
			return boundedBuckets
				.slice()
				.sort((left, right) => left.percentRemaining - right.percentRemaining)[0] ?? null;
		}

		return buckets.find(bucket =>
			bucket.name === 'premium_interactions' || bucket.name === 'premium_models'
		) ?? buckets[0] ?? null;
	}

	buildAuthQuotaWindows(
		buckets: CopilotResolvedQuotaBucket[],
		resetDate?: Date
	): QuotaWindowUsage[] | undefined {
		const windows = buckets
			.filter(bucket => !bucket.unlimited && bucket.quota > 0)
			.filter(bucket => bucket.name === 'chat' || bucket.name === 'completions')
			.sort((left, right) => this.getQuotaWindowSortOrder(left.name) - this.getQuotaWindowSortOrder(right.name))
			.map(bucket => ({
				label: this.getQuotaWindowLabel(bucket.name),
				used: Math.round(bucket.used),
				limit: Math.round(bucket.quota),
				resetTime: resetDate,
			}));

		return windows.length > 0 ? windows : undefined;
	}

	getQuotaWindowSortOrder(bucketName: CopilotResolvedBucketName): number {
		switch (bucketName) {
			case 'chat': return 0;
			case 'completions': return 1;
			case 'premium_interactions': return 2;
			case 'premium_models': return 3;
		}
	}

	getQuotaWindowLabel(bucketName: CopilotResolvedBucketName): string {
		switch (bucketName) {
			case 'chat': return 'Chat messages';
			case 'completions': return 'Inline suggestions';
			case 'premium_interactions': return 'Premium chat';
			case 'premium_models': return 'Premium models';
		}
	}

	describeAuthBuckets(buckets: CopilotResolvedQuotaBucket[]): string {
		return buckets
			.map(bucket => `${bucket.name}:${Math.round(bucket.used)}/${Math.round(bucket.quota)}:${Math.round(bucket.percentRemaining)}%`)
			.join(', ');
	}

	parseQuotaHeader(
		headerName: CopilotQuotaHeaderName,
		rawValue: string,
		source: CopilotSignalSource,
		surface: CopilotSurface,
		url: string
	): CopilotQuotaSnapshot | null {
		try {
			const params = new URLSearchParams(rawValue);
			const quota = toFiniteNumber(params.get('ent'));
			const percentRemaining = toFiniteNumber(params.get('rem'));
			if (quota === null || percentRemaining === null) {
				return null;
			}

			const resetDate = toDate(params.get('rst'));
			return {
				quota,
				used: Math.max(0, quota * (1 - percentRemaining / 100)),
				resetDate,
				overageEnabled: params.get('ovPerm') === 'true',
				overageUsed: toFiniteNumber(params.get('ov')) ?? 0,
				unlimited: quota === -1,
				surface,
				source,
				detail: `${url} (${headerName})`,
				observedAt: this.deps.now(),
			};
		} catch (error) {
			this.logParseFailure(`${source}:${headerName}:${rawValue}`, `[Copilot Net] Failed to parse ${headerName}: ${String(error)}`);
			return null;
		}
	}

	normalizeQuotaInfoValue(
		value: unknown,
		detail: string,
		source: CopilotSignalSource,
		surface: CopilotSurface
	): CopilotQuotaSnapshot | null {
		const quotaInfo = this.readQuotaInfo(value);
		if (!quotaInfo) {
			return null;
		}

		const quota = toFiniteNumber(quotaInfo.quota);
		const used = toFiniteNumber(quotaInfo.used);
		if (quota === null || used === null) {
			return null;
		}

		return {
			quota,
			used,
			resetDate: toDate(quotaInfo.resetDate),
			overageEnabled: Boolean(quotaInfo.overageEnabled),
			overageUsed: toFiniteNumber(quotaInfo.overageUsed) ?? 0,
			unlimited: Boolean(quotaInfo.unlimited) || quota === -1,
			surface,
			source,
			detail,
			observedAt: this.deps.now(),
		};
	}

	normalizeQuotaSnapshotsValue(
		value: unknown,
		detail: string,
		source: CopilotSignalSource,
		surface: CopilotSurface
	): CopilotQuotaSnapshot | null {
		if (!isRecord(value) || !('quota_snapshots' in value) || !('quota_reset_date' in value)) {
			return null;
		}

		const snapshots = (value as { quota_snapshots?: unknown }).quota_snapshots;
		if (!isRecord(snapshots)) {
			return null;
		}

		const bucket = this.readQuotaSnapshotBucket(snapshots);
		if (!bucket) {
			return null;
		}

		const quota = toFiniteNumber(bucket.entitlement);
		const percentRemaining = toFiniteNumber(bucket.percent_remaining);
		if (quota === null || percentRemaining === null) {
			return null;
		}

		return {
			quota,
			used: Math.max(0, quota * (1 - percentRemaining / 100)),
			resetDate: toDate((value as { quota_reset_date?: unknown }).quota_reset_date),
			overageEnabled: Boolean(bucket.overage_permitted),
			overageUsed: toFiniteNumber(bucket.overage_count) ?? 0,
			unlimited: Boolean(bucket.unlimited) || quota === -1,
			surface,
			source,
			detail,
			observedAt: this.deps.now(),
		};
	}

	readQuotaInfo(value: unknown): CopilotQuotaInfoLike | null {
		if (!isRecord(value)) {
			return null;
		}

		if (isRecord((value as { quotaInfo?: unknown }).quotaInfo)) {
			return (value as { quotaInfo: CopilotQuotaInfoLike }).quotaInfo;
		}

		const hasQuotaInfoFields = 'quota' in value || 'used' in value || 'resetDate' in value;
		return hasQuotaInfoFields ? value as CopilotQuotaInfoLike : null;
	}

	readQuotaSnapshotBucket(value: Record<string, unknown>): CopilotQuotaSnapshotBucket | null {
		const candidateKeys = ['premium_interactions', 'premium_models', 'chat'];
		for (const key of candidateKeys) {
			const bucket = value[key];
			if (isRecord(bucket)) {
				return bucket as CopilotQuotaSnapshotBucket;
			}
		}
		return null;
	}
}
