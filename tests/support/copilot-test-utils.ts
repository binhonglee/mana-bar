import { vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { FixedClock } from './provider-test-utils';
import type { ResolvedCopilotProviderDeps, CopilotQuotaSnapshot } from '../../src/providers/copilot/types';

export interface TestDeps {
	deps: ResolvedCopilotProviderDeps;
	logParseFailure: Mock;
	recordSnapshot: Mock;
}

/**
 * Creates a fully-mocked `ResolvedCopilotProviderDeps` along with
 * `logParseFailure` and `recordSnapshot` spy functions.
 *
 * The returned `deps.now` uses a `FixedClock` starting at the given time
 * (default: 1_000_000). Access the clock via `deps.now` to advance time.
 */
export function createTestDeps(options: {
	clockStart?: number;
	fetchAvailable?: boolean;
} = {}): TestDeps {
	const clock = new FixedClock(options.clockStart ?? 1_000_000);

	const fakeHttpsModule = {
		request: vi.fn(() => new EventEmitter()),
		get: vi.fn(() => new EventEmitter()),
	} as unknown as ResolvedCopilotProviderDeps['httpsModule'];

	const globalObject: { fetch?: typeof fetch } = {};
	if (options.fetchAvailable !== false) {
		globalObject.fetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
	}

	const deps: ResolvedCopilotProviderDeps = {
		httpsModule: fakeHttpsModule,
		now: clock.now,
		vscodeApi: vscode as unknown as typeof import('vscode'),
		globalObject,
		execFile: vi.fn() as unknown as ResolvedCopilotProviderDeps['execFile'],
		homeDir: '/fake/home',
		platform: 'linux',
		env: {},
		readPersistedSecret: vi.fn(async () => null),
	};

	return {
		deps,
		logParseFailure: vi.fn(),
		recordSnapshot: vi.fn(),
	};
}
