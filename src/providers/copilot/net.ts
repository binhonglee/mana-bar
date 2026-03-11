import {
	CopilotSignalSource,
	CopilotSurface,
	HeadersLike,
	HttpsGet,
	HttpsRequest,
	NodeRequestLike,
	ResolvedCopilotProviderDeps,
	CopilotQuotaSnapshot
} from './types';
import {
	classifySurfaceFromStack,
	describeHttpsRequest,
	findQuotaHeader,
	findQuotaHeaderName,
	getFetchUrl,
	summarizeStack
} from './utils';
import { CopilotParser } from './parse';

export class CopilotNetInterceptor {
	private originalFetch?: typeof fetch;
	private originalHttpsRequest?: HttpsRequest;
	private originalHttpsGet?: HttpsGet;

	constructor(
		private readonly deps: ResolvedCopilotProviderDeps,
		private readonly parser: CopilotParser,
		private readonly recordSnapshot: (snapshot: CopilotQuotaSnapshot) => void,
		private readonly logParseFailure: (key: string, message: string) => void
	) { }

	patchFetch(): void {
		if (typeof this.deps.globalObject.fetch !== 'function') {
			return;
		}

		this.originalFetch = this.deps.globalObject.fetch;
		const originalFetch = this.originalFetch;

		this.deps.globalObject.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
			const stack = new Error().stack;
			const response = await originalFetch.call(this.deps.globalObject, input, init);
			try {
				this.inspectHeaders(
					'fetch',
					response.headers,
					getFetchUrl(input, response.url),
					classifySurfaceFromStack(stack, findQuotaHeaderName(response.headers)),
					stack
				);
			} catch (error) {
				console.error('[Copilot Net] Failed to inspect fetch response:', error);
			}
			return response;
		}) as typeof fetch;
	}

	patchHttps(): void {
		this.originalHttpsRequest = this.deps.httpsModule.request;
		this.originalHttpsGet = this.deps.httpsModule.get;

		const originalRequest = this.originalHttpsRequest;
		const originalGet = this.originalHttpsGet;

		this.deps.httpsModule.request = ((...args: unknown[]) => {
			const stack = new Error().stack;
			const request = originalRequest.call(this.deps.httpsModule, ...(args as Parameters<HttpsRequest>));
			this.attachNodeResponseInspector(request as NodeRequestLike, args, stack);
			return request;
		}) as HttpsRequest;

		this.deps.httpsModule.get = ((...args: unknown[]) => {
			const stack = new Error().stack;
			const request = originalGet.call(this.deps.httpsModule, ...(args as Parameters<HttpsGet>));
			this.attachNodeResponseInspector(request as NodeRequestLike, args, stack);
			return request;
		}) as HttpsGet;
	}

	private attachNodeResponseInspector(request: NodeRequestLike, args: unknown[], stack?: string): void {
		request.on('response', (response) => {
			try {
				const headerName = findQuotaHeaderName(response.headers ?? {});
				this.inspectHeaders(
					'https',
					response.headers ?? {},
					describeHttpsRequest(args),
					classifySurfaceFromStack(stack, headerName),
					stack
				);
			} catch (error) {
				console.error('[Copilot Net] Failed to inspect https response:', error);
			}
		});
	}

	private inspectHeaders(
		source: CopilotSignalSource,
		headers: HeadersLike,
		url: string,
		surface: CopilotSurface,
		stack?: string
	): void {
		const header = findQuotaHeader(headers);
		if (!header) {
			return;
		}

		const parsed = this.parser.parseQuotaHeader(header.name, header.value, source, surface, url);
		if (!parsed) {
			this.logParseFailure(`${source}:${header.name}:${header.value}`, `[Copilot Net] Failed to parse ${header.name} from ${url}`);
			return;
		}

		const stackSum = summarizeStack(stack);
		const detail = `${url} (${header.name}${stackSum ? `; ${stackSum}` : ''})`;
		this.recordSnapshot({
			...parsed,
			detail,
		});
	}

	dispose(): void {
		if (this.originalFetch) {
			this.deps.globalObject.fetch = this.originalFetch;
		}

		if (this.originalHttpsRequest) {
			this.deps.httpsModule.request = this.originalHttpsRequest;
		}

		if (this.originalHttpsGet) {
			this.deps.httpsModule.get = this.originalHttpsGet;
		}
	}
}
