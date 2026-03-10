import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../../src/providers/codex';
import {
	createExtensionContext,
	FakeChildProcess,
	FakeGlobalState,
	FixedClock,
} from '../support/provider-test-utils';

const RATE_LIMITS_RESPONSE = {
	id: 2,
	result: {
		rateLimits: {
			primary: {
				usedPercent: 48,
				windowDurationMins: 1440,
				resetsAt: Math.floor(Date.parse('2026-03-11T10:00:00.000Z') / 1000),
			},
			secondary: {
				usedPercent: 72,
				windowDurationMins: 10080,
				resetsAt: Math.floor(Date.parse('2026-03-17T10:00:00.000Z') / 1000),
			},
		},
	},
};

describe('CodexProvider', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('checks whether the codex CLI is available', async () => {
		const available = new CodexProvider(createExtensionContext(), {
			exec: async () => ({ stdout: '/usr/local/bin/codex\n' }),
		});
		const unavailable = new CodexProvider(createExtensionContext(), {
			exec: async () => {
				throw new Error('missing');
			},
		});

		await expect(available.isAvailable()).resolves.toBe(true);
		await expect(unavailable.isAvailable()).resolves.toBe(false);
	});

	it('cleans up orphaned app-server processes from global state', async () => {
		const globalState = new FakeGlobalState();
		await globalState.update('codexAppServerPid', 999);
		const kill = vi.fn();
		new CodexProvider(createExtensionContext(globalState), {
			exec: async (command) => {
				if (command.startsWith('ps -p 999')) {
					return { stdout: 'codex app-server\n' };
				}
				return { stdout: '' };
			},
			kill,
		});

		await vi.waitFor(() => {
			expect(kill).toHaveBeenCalledWith(999, 'SIGTERM');
		});
		expect(globalState.get('codexAppServerPid')).toBeUndefined();
	});

	it('spawns, initializes, and caches rate-limit responses', async () => {
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const globalState = new FakeGlobalState();
		const process = new FakeChildProcess(1234);
		process.stdin.write = vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
			const payload = JSON.parse(chunk.trim());
			if (payload.method === 'initialize') {
				queueMicrotask(() => process.emitJson({ id: payload.id, result: {} }));
			} else if (payload.method === 'account/rateLimits/read') {
				queueMicrotask(() => process.emitJson({ ...RATE_LIMITS_RESPONSE, id: payload.id }));
			}
			callback?.(null);
			return true;
		});

		const provider = new CodexProvider(createExtensionContext(globalState), {
			now: clock.now,
			exec: async () => ({ stdout: '/usr/local/bin/codex\n' }),
			spawn: () => process as any,
		});

		const first = await provider.getUsage();
		const second = await provider.getUsage();

		expect(first?.totalUsed).toBe(72);
		expect(second).toEqual(first);
		expect(process.stdin.write).toHaveBeenCalledTimes(3);
		expect(globalState.get('codexAppServerPid')).toBe(1234);
	});

	it('returns stale cached data when a later request times out', async () => {
		vi.useFakeTimers();
		const clock = new FixedClock(Date.parse('2026-03-10T10:00:00.000Z'));
		const process = new FakeChildProcess(1234);
		let respondToRateLimits = true;
		process.stdin.write = vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
			const payload = JSON.parse(chunk.trim());
			if (payload.method === 'initialize') {
				queueMicrotask(() => process.emitJson({ id: payload.id, result: {} }));
			} else if (payload.method === 'account/rateLimits/read' && respondToRateLimits) {
				queueMicrotask(() => process.emitJson({ ...RATE_LIMITS_RESPONSE, id: payload.id }));
			}
			callback?.(null);
			return true;
		});

		const provider = new CodexProvider(createExtensionContext(), {
			now: clock.now,
			exec: async () => ({ stdout: '/usr/local/bin/codex\n' }),
			spawn: () => process as any,
			setTimeout,
			clearTimeout,
		});

		const firstPromise = provider.getUsage();
		await vi.advanceTimersByTimeAsync(101);
		const first = await firstPromise;
		clock.advance(181_000);
		respondToRateLimits = false;
		const secondPromise = provider.getUsage();
		await vi.advanceTimersByTimeAsync(5_001);
		const second = await secondPromise;

		expect(second).toEqual(first);
	});

	it('disposes the spawned app-server and clears stored state', async () => {
		const globalState = new FakeGlobalState();
		const process = new FakeChildProcess(1234);
		process.stdin.write = vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
			const payload = JSON.parse(chunk.trim());
			if (payload.method === 'initialize') {
				queueMicrotask(() => process.emitJson({ id: payload.id, result: {} }));
			} else if (payload.method === 'account/rateLimits/read') {
				queueMicrotask(() => process.emitJson({ ...RATE_LIMITS_RESPONSE, id: payload.id }));
			}
			callback?.(null);
			return true;
		});

		const provider = new CodexProvider(createExtensionContext(globalState), {
			exec: async () => ({ stdout: '/usr/local/bin/codex\n' }),
			spawn: () => process as any,
		});

		await provider.getUsage();
		provider.dispose();

		expect(process.killSignals).toEqual(['SIGTERM']);
		expect(globalState.get('codexAppServerPid')).toBeUndefined();
	});
});
