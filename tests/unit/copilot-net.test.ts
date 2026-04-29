import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { CopilotNetInterceptor } from '../../src/providers/copilot/net';
import { CopilotParser } from '../../src/providers/copilot/parse';
import { createTestDeps, type TestDeps } from '../support/copilot-test-utils';
import type { ResolvedCopilotProviderDeps } from '../../src/providers/copilot/types';

describe('CopilotNetInterceptor', () => {
	let testDeps: TestDeps;
	let parser: CopilotParser;
	let interceptor: CopilotNetInterceptor;

	beforeEach(() => {
		testDeps = createTestDeps();
		parser = new CopilotParser(testDeps.deps, testDeps.logParseFailure);
		interceptor = new CopilotNetInterceptor(
			testDeps.deps,
			parser,
			testDeps.recordSnapshot,
			testDeps.logParseFailure
		);
	});

	afterEach(() => {
		interceptor.dispose();
		testDeps = undefined!;
		parser = undefined!;
		interceptor = undefined!;
	});

	describe('patchFetch', () => {
		describe('with quota headers present', () => {
			it('calls recordSnapshot when response has a quota header', async () => {
				const quotaValue = 'ent=100&rem=60&rst=2026-03-10T18:00:00.000Z&ovPerm=false&ov=0';
				const fakeResponse = new Response('', {
					status: 200,
					headers: {
						'x-quota-snapshot-premium_interactions': quotaValue,
					},
				});

				testDeps.deps.globalObject.fetch = vi.fn(async () => fakeResponse) as unknown as typeof fetch;
				interceptor.patchFetch();

				await testDeps.deps.globalObject.fetch!('https://api.github.com/copilot_internal/chat', {});
				expect(testDeps.recordSnapshot).toHaveBeenCalledTimes(1);

				const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
				expect(snapshot.quota).toBe(100);
				expect(snapshot.used).toBeCloseTo(100 * (1 - 60 / 100));
				expect(snapshot.source).toBe('fetch');
				expect(snapshot.overageEnabled).toBe(false);
				expect(snapshot.overageUsed).toBe(0);
			});

			it('parses the highest-priority quota header when multiple are present', async () => {
				const premiumValue = 'ent=200&rem=50&ovPerm=true&ov=5';
				const chatValue = 'ent=50&rem=80&ovPerm=false&ov=0';
				const fakeResponse = new Response('', {
					status: 200,
					headers: {
						'x-quota-snapshot-premium_interactions': premiumValue,
						'x-quota-snapshot-chat': chatValue,
					},
				});

				testDeps.deps.globalObject.fetch = vi.fn(async () => fakeResponse) as unknown as typeof fetch;
				interceptor.patchFetch();

				await testDeps.deps.globalObject.fetch!('https://api.github.com/test', {});
				expect(testDeps.recordSnapshot).toHaveBeenCalledTimes(1);

				const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
				// premium_interactions has higher priority than chat
				expect(snapshot.quota).toBe(200);
			});
		});

		describe('with quota headers absent', () => {
			it('does not call recordSnapshot when response has no quota headers', async () => {
				const fakeResponse = new Response('{"ok": true}', {
					status: 200,
					headers: {
						'content-type': 'application/json',
					},
				});

				testDeps.deps.globalObject.fetch = vi.fn(async () => fakeResponse) as unknown as typeof fetch;
				interceptor.patchFetch();

				await testDeps.deps.globalObject.fetch!('https://api.github.com/test', {});
				expect(testDeps.recordSnapshot).not.toHaveBeenCalled();
			});
		});

		describe('when global fetch is unavailable', () => {
			it('completes without error when fetch is not defined', () => {
				const nofetchDeps = createTestDeps({ fetchAvailable: false });
				const nofetchParser = new CopilotParser(nofetchDeps.deps, nofetchDeps.logParseFailure);
				const nofetchInterceptor = new CopilotNetInterceptor(
					nofetchDeps.deps,
					nofetchParser,
					nofetchDeps.recordSnapshot,
					nofetchDeps.logParseFailure
				);

				expect(() => nofetchInterceptor.patchFetch()).not.toThrow();
			});

			it('does not set fetch on globalObject when fetch is unavailable', () => {
				const nofetchDeps = createTestDeps({ fetchAvailable: false });
				const nofetchParser = new CopilotParser(nofetchDeps.deps, nofetchDeps.logParseFailure);
				const nofetchInterceptor = new CopilotNetInterceptor(
					nofetchDeps.deps,
					nofetchParser,
					nofetchDeps.recordSnapshot,
					nofetchDeps.logParseFailure
				);

				nofetchInterceptor.patchFetch();
				expect(nofetchDeps.deps.globalObject.fetch).toBeUndefined();
			});
		});
	});

	describe('patchHttps', () => {
		it('calls recordSnapshot when https response has a quota header', () => {
			const originalRequest = testDeps.deps.httpsModule.request;
			const fakeRequest = new EventEmitter();
			(testDeps.deps.httpsModule.request as ReturnType<typeof vi.fn>).mockReturnValue(fakeRequest);

			interceptor.patchHttps();

			// Trigger a request through the patched https.request
			const req = testDeps.deps.httpsModule.request(
				{ hostname: 'api.github.com', path: '/copilot_internal/chat', protocol: 'https:' },
				() => {}
			);

			// Simulate a response with quota headers
			const quotaValue = 'ent=500&rem=40&rst=2026-06-01T00:00:00.000Z&ovPerm=true&ov=10';
			(req as unknown as EventEmitter).emit('response', {
				headers: {
					'x-quota-snapshot-premium_interactions': quotaValue,
				},
			});

			expect(testDeps.recordSnapshot).toHaveBeenCalledTimes(1);
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(500);
			expect(snapshot.used).toBeCloseTo(500 * (1 - 40 / 100));
			expect(snapshot.source).toBe('https');
			expect(snapshot.overageEnabled).toBe(true);
			expect(snapshot.overageUsed).toBe(10);
		});

		it('calls recordSnapshot when https.get response has a quota header', () => {
			const fakeRequest = new EventEmitter();
			(testDeps.deps.httpsModule.get as ReturnType<typeof vi.fn>).mockReturnValue(fakeRequest);

			interceptor.patchHttps();

			const req = testDeps.deps.httpsModule.get(
				'https://api.github.com/copilot_internal/user',
				() => {}
			);

			const quotaValue = 'ent=100&rem=90&ovPerm=false&ov=0';
			(req as unknown as EventEmitter).emit('response', {
				headers: {
					'x-quota-snapshot-chat': quotaValue,
				},
			});

			expect(testDeps.recordSnapshot).toHaveBeenCalledTimes(1);
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(100);
			expect(snapshot.surface).toBe('chat');
		});

		it('does not call recordSnapshot when https response has no quota headers', () => {
			const fakeRequest = new EventEmitter();
			(testDeps.deps.httpsModule.request as ReturnType<typeof vi.fn>).mockReturnValue(fakeRequest);

			interceptor.patchHttps();

			const req = testDeps.deps.httpsModule.request(
				{ hostname: 'api.github.com', path: '/other', protocol: 'https:' },
				() => {}
			);

			(req as unknown as EventEmitter).emit('response', {
				headers: {
					'content-type': 'application/json',
				},
			});

			expect(testDeps.recordSnapshot).not.toHaveBeenCalled();
		});
	});

	describe('dispose', () => {
		it('restores original fetch after patchFetch', async () => {
			const originalFetch = testDeps.deps.globalObject.fetch;
			interceptor.patchFetch();

			// fetch should be patched (different from original)
			expect(testDeps.deps.globalObject.fetch).not.toBe(originalFetch);

			interceptor.dispose();
			expect(testDeps.deps.globalObject.fetch).toBe(originalFetch);
		});

		it('restores original https.request and https.get after patchHttps', () => {
			const originalRequest = testDeps.deps.httpsModule.request;
			const originalGet = testDeps.deps.httpsModule.get;

			interceptor.patchHttps();

			expect(testDeps.deps.httpsModule.request).not.toBe(originalRequest);
			expect(testDeps.deps.httpsModule.get).not.toBe(originalGet);

			interceptor.dispose();

			expect(testDeps.deps.httpsModule.request).toBe(originalRequest);
			expect(testDeps.deps.httpsModule.get).toBe(originalGet);
		});

		it('restores all patched functions when both fetch and https are patched', async () => {
			const originalFetch = testDeps.deps.globalObject.fetch;
			const originalRequest = testDeps.deps.httpsModule.request;
			const originalGet = testDeps.deps.httpsModule.get;

			interceptor.patchFetch();
			interceptor.patchHttps();

			interceptor.dispose();

			expect(testDeps.deps.globalObject.fetch).toBe(originalFetch);
			expect(testDeps.deps.httpsModule.request).toBe(originalRequest);
			expect(testDeps.deps.httpsModule.get).toBe(originalGet);
		});

		it('does not throw when dispose is called without patching', () => {
			expect(() => interceptor.dispose()).not.toThrow();
		});
	});
});
