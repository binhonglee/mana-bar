import { describe, expect, it, vi } from 'vitest';
import { OpenCodeGoProvider } from '../../src/providers/opencode-go';

const usagePayload = {
	usage: {
		rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-24T07:26:43.000Z' },
		weekly: { status: 'ok', percent: 0, resetsAt: '2026-08-31T00:00:00.000Z' },
		monthly: { status: 'ok', percent: 19, resetsAt: '2026-09-02T07:09:09.000Z' },
	},
};

describe('OpenCodeGoProvider', () => {
	it('is available when the API key is provided via environment', async () => {
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
	});

	it('reads the API key from the OpenCode auth.json file', async () => {
		const readJsonFile = vi.fn(async () => ({ 'opencode-go': { type: 'api', key: 'sk-from-file' } }));
		const provider = new OpenCodeGoProvider({
			env: {},
			homeDir: '/home/tester',
			readJsonFile: readJsonFile as never,
		});

		await expect(provider.isAvailable()).resolves.toBe(true);
		expect(readJsonFile).toHaveBeenCalledWith('/home/tester/.local/share/opencode/auth.json');
	});

	it('prefers the environment key over the auth.json file', async () => {
		const readJsonFile = vi.fn(async () => ({ 'opencode-go': { type: 'api', key: 'sk-from-file' } }));
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(usagePayload)));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-from-env' },
			readJsonFile: readJsonFile as never,
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();

		expect(readJsonFile).not.toHaveBeenCalled();
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-from-env');
	});

	it('honors XDG_DATA_HOME for the auth.json path', async () => {
		const readJsonFile = vi.fn(async () => null);
		const provider = new OpenCodeGoProvider({
			env: { XDG_DATA_HOME: '/xdg/data' },
			homeDir: '/home/tester',
			readJsonFile: readJsonFile as never,
		});

		await provider.isAvailable();
		expect(readJsonFile).toHaveBeenCalledWith('/xdg/data/opencode/auth.json');
	});

	it('is unavailable when no key is present', async () => {
		const provider = new OpenCodeGoProvider({
			env: {},
			readJsonFile: (async () => null) as never,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('ignores an auth entry whose type is not "api"', async () => {
		const readJsonFile = vi.fn(async () => ({ 'opencode-go': { type: 'oauth', key: 'sk-leftover' } }));
		const provider = new OpenCodeGoProvider({
			env: {},
			readJsonFile: readJsonFile as never,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});

	it('fetches usage and caches responses', async () => {
		const now = vi.fn(() => Date.parse('2026-08-24T00:00:00.000Z'));
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(usagePayload)));
		const provider = new OpenCodeGoProvider({
			now,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();
		const second = await provider.getUsage();

		expect(first?.serviceId).toBe('opencodeGo');
		expect(first?.totalLimit).toBe(100);
		expect(first?.quotaWindows?.map((window) => window.label)).toEqual(['Rolling', 'Weekly', 'Monthly']);
		expect(second).toEqual(first);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('sends the bearer token to the usage endpoint', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(usagePayload)));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();

		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://opencode.ai/zen/go/v1/usage');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
	});

	it('uses the base URL override and trims a trailing slash', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(usagePayload)));
		const provider = new OpenCodeGoProvider({
			env: {
				MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test',
				MANA_BAR_OPENCODE_GO_API_BASE: 'https://proxy.example.com/go/',
			},
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();

		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toBe('https://proxy.example.com/go/usage');
	});

	it('reports reauth health when the key is rejected', async () => {
		const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-bad' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
		expect(provider.getLastServiceHealth()?.kind).toBe('reauthRequired');
	});

	it('reports reauth health on HTTP 403', async () => {
		const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-bad' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
		expect(provider.getLastServiceHealth()?.kind).toBe('reauthRequired');
	});

	it('keeps the last usage and reports health across a clearCache refresh that fails', async () => {
		// Reproduces the real UsageManager flow, which calls clearCache() before
		// every refresh. The stale usage must survive so the numbers do not vanish.
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response(JSON.stringify(usagePayload))
				: new Response('boom', { status: 500 });
		});
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();
		provider.clearCache();
		const second = await provider.getUsage();

		expect(second).toEqual(first);
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('reports unavailable health when an unexpected HTTP status is returned', async () => {
		const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
	});

	it('reports unavailable health when the response body is not valid JSON', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
		errorSpy.mockRestore();
	});

	it('honors a rate-limit cooldown and does not refetch until it elapses', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return new Response(JSON.stringify(usagePayload));
			}
			return new Response('slow down', { status: 429 });
		});
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();

		clock += 10 * 60 * 1000; // expire the usage cache
		await provider.getUsage(); // hits 429, opens the cooldown
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(provider.getLastServiceHealth()?.kind).toBe('rateLimited');

		clock += 30 * 1000; // still inside the default 2-minute cooldown
		provider.clearCache();
		const during = await provider.getUsage();

		// No third request; stale usage and rate-limited health both preserved.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(during).toEqual(first);
		expect(provider.getLastServiceHealth()?.kind).toBe('rateLimited');
	});

	it('respects the Retry-After header for the cooldown length', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		const fetchImpl = vi.fn(async () => new Response('slow down', {
			status: 429,
			headers: { 'retry-after': '30' },
		}));
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 20 * 1000; // within the 30s Retry-After window
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 15 * 1000; // now past 30s
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('does not follow redirects when requesting usage', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(usagePayload)));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(init.redirect).toBe('error');
	});

	it('clears reauth health once the key works again', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response('unauthorized', { status: 401 })
				: new Response(JSON.stringify(usagePayload));
		});
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();
		expect(provider.getLastServiceHealth()?.kind).toBe('reauthRequired');

		clock += 10 * 60 * 1000;
		const usage = await provider.getUsage();

		expect(usage?.serviceId).toBe('opencodeGo');
		expect(provider.getLastServiceHealth()).toBeNull();
	});

	it('returns the stale cache and reports rate-limited health on HTTP 429', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response(JSON.stringify(usagePayload))
				: new Response('slow down', { status: 429 });
		});
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();
		clock += 10 * 60 * 1000;
		const second = await provider.getUsage();

		expect(second).toEqual(first);
		expect(provider.getLastServiceHealth()?.kind).toBe('rateLimited');
	});

	it('reports unavailable health on an HTTP 500', async () => {
		const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
	});

	it('reports rate-limited health when a window status is not ok, while still returning usage', async () => {
		const blockedPayload = {
			usage: {
				rolling: { status: 'ok', percent: 10, resetsAt: '2026-08-24T07:26:43.000Z' },
				weekly: { status: 'exceeded', percent: 100, resetsAt: '2026-08-31T00:00:00.000Z' },
				monthly: { status: 'ok', percent: 40, resetsAt: '2026-09-02T07:09:09.000Z' },
			},
		};
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(blockedPayload)));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage?.totalUsed).toBe(100);
		const health = provider.getLastServiceHealth();
		expect(health?.kind).toBe('rateLimited');
		expect(health?.summary).toContain('Weekly');
	});

	it('reports unavailable health for a 200 response with no windows', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ usage: {} })));
		const provider = new OpenCodeGoProvider({
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const usage = await provider.getUsage();

		expect(usage).toBeNull();
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
	});

	it('swallows an unexpected HTTP error and returns the stale cache', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response(JSON.stringify(usagePayload))
				: new Response('bad request', { status: 400 });
		});
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();
		clock += 10 * 60 * 1000;
		const second = await provider.getUsage();

		expect(second).toEqual(first);
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('returns the stale cache and logs when a fetch fails after the cache expires', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return new Response(JSON.stringify(usagePayload));
			}
			throw new Error('network down');
		});
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		const first = await provider.getUsage();
		clock += 10 * 60 * 1000; // move past the 3-minute cache TTL
		const second = await provider.getUsage();

		expect(second).toEqual(first);
		expect(provider.getLastServiceHealth()?.kind).toBe('unavailable');
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('clears rate-limited health and refetches after the cooldown ends', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response('slow down', { status: 429 })
				: new Response(JSON.stringify(usagePayload));
		});
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage(); // 429 opens the 2-minute cooldown
		expect(provider.getLastServiceHealth()?.kind).toBe('rateLimited');

		clock += 3 * 60 * 1000; // past the cooldown
		const recovered = await provider.getUsage();

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(recovered?.serviceId).toBe('opencodeGo');
		expect(provider.getLastServiceHealth()).toBeNull();
	});

	it('accepts an HTTP-date Retry-After header', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		const fetchImpl = vi.fn(async () => new Response('slow down', {
			status: 429,
			headers: { 'retry-after': 'Mon, 24 Aug 2026 00:01:00 GMT' },
		}));
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 40 * 1000; // within the ~60s date window
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 30 * 1000; // now past the date
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('caps an absurd Retry-After at one hour exactly', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		const fetchImpl = vi.fn(async () => new Response('slow down', {
			status: 429,
			headers: { 'retry-after': '1e308' },
		}));
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();

		clock += 59 * 60 * 1000; // still within the 1-hour cap
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 2 * 60 * 1000; // now past the 1-hour cap
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('caps a far-future HTTP-date Retry-After at one hour', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		const fetchImpl = vi.fn(async () => new Response('slow down', {
			status: 429,
			headers: { 'retry-after': 'Wed, 01 Jan 2031 00:00:00 GMT' },
		}));
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();
		clock += 61 * 60 * 1000; // past the 1-hour cap despite the years-away date
		await provider.getUsage();

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('falls back to the default cooldown for a whitespace-only Retry-After', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		const fetchImpl = vi.fn(async () => new Response('slow down', {
			status: 429,
			headers: { 'retry-after': '   ' },
		}));
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();

		clock += 60 * 1000; // within the default 2-minute cooldown
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 90 * 1000; // past 2 minutes
		await provider.getUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('treats a past-date Retry-After as an elapsed cooldown', async () => {
		let clock = Date.parse('2026-08-24T00:00:00.000Z');
		const fetchImpl = vi.fn(async () => new Response('slow down', {
			status: 429,
			headers: { 'retry-after': 'Sun, 23 Aug 2026 00:00:00 GMT' },
		}));
		const provider = new OpenCodeGoProvider({
			now: () => clock,
			env: { MANA_BAR_OPENCODE_GO_API_KEY: 'sk-test' },
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await provider.getUsage();
		clock += 1000; // cooldown clamped to zero, so the next poll refetches
		await provider.getUsage();

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('does not throw when the auth.json key is not a string', async () => {
		const readJsonFile = vi.fn(async () => ({ 'opencode-go': { type: 'api', key: 12345 } }));
		const provider = new OpenCodeGoProvider({
			env: {},
			readJsonFile: readJsonFile as never,
		});

		await expect(provider.isAvailable()).resolves.toBe(false);
	});
});
