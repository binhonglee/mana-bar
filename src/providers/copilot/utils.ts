import { CopilotQuotaHeaderName, CopilotResolvedBucketName, CopilotSurface, HeadersLike, QUOTA_HEADER_PRIORITY } from './types';

export function toFiniteNumber(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function toDate(value: unknown): Date | undefined {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value;
	}
	if (typeof value === 'string' || typeof value === 'number') {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}
	return undefined;
}

export function summarizeStack(stack?: string): string {
	if (!stack) {
		return '';
	}

	const lines = stack
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.includes('github.copilot'));

	return lines[0] ?? '';
}

export function classifySurfaceFromExtensionId(extensionId: string): CopilotSurface {
	return extensionId === 'GitHub.copilot-chat' ? 'chat' : 'completions';
}

export function classifySurfaceFromBucketName(bucketName: CopilotResolvedBucketName): CopilotSurface {
	if (bucketName === 'chat') {
		return 'chat';
	}
	if (bucketName === 'completions') {
		return 'completions';
	}
	return 'premium';
}

export function classifySurfaceFromStack(stack?: string, headerName?: CopilotQuotaHeaderName | null): CopilotSurface {
	if (headerName === 'x-quota-snapshot-chat') {
		return 'chat';
	}
	if (headerName === 'x-quota-snapshot-premium_interactions' || headerName === 'x-quota-snapshot-premium_models') {
		return 'premium';
	}

	if (!stack) {
		return 'unknown';
	}

	const normalizedStack = stack.toLowerCase();
	if (normalizedStack.includes('github.copilot-chat')) {
		return 'chat';
	}
	if (normalizedStack.includes('github.copilot-') || normalizedStack.includes('github.copilot/')) {
		return 'completions';
	}
	return 'unknown';
}

export function getFetchUrl(input: Request | string | URL, fallbackUrl: string): string {
	if (typeof input === 'string') {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') {
		return input.url;
	}
	return fallbackUrl || 'unknown fetch request';
}

export function describeHttpsRequest(args: unknown[]): string {
	const [first, second] = args;
	if (first instanceof URL) {
		return first.toString();
	}
	if (typeof first === 'string') {
		return first;
	}
	if (isRecord(first)) {
		return describeHttpsOptions(first);
	}
	if (isRecord(second)) {
		return describeHttpsOptions(second);
	}
	return 'unknown https request';
}

function describeHttpsOptions(options: Record<string, unknown>): string {
	const protocol = typeof options.protocol === 'string' ? options.protocol : 'https:';
	const host = typeof options.hostname === 'string'
		? options.hostname
		: typeof options.host === 'string'
			? options.host
			: 'unknown-host';
	const path = typeof options.path === 'string' ? options.path : '';
	return `${protocol}//${host}${path}`;
}

export function findQuotaHeader(headers: HeadersLike): { name: CopilotQuotaHeaderName; value: string } | null {
	for (const headerName of QUOTA_HEADER_PRIORITY) {
		const headerValue = getHeaderValue(headers, headerName);
		if (headerValue) {
			return { name: headerName, value: headerValue };
		}
	}
	return null;
}

export function findQuotaHeaderName(headers: HeadersLike): CopilotQuotaHeaderName | null {
	return findQuotaHeader(headers)?.name ?? null;
}

export function getHeaderValue(headers: HeadersLike, headerName: string): string | null {
	if (headers && typeof (headers as Headers).get === 'function') {
		return (headers as Headers).get(headerName);
	}

	const lowerHeaderName = headerName.toLowerCase();
	const headerValue = Object.entries(headers).find(([name]) => name.toLowerCase() === lowerHeaderName)?.[1];
	if (Array.isArray(headerValue)) {
		return headerValue[0] ?? null;
	}
	return (headerValue as string) ?? null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
