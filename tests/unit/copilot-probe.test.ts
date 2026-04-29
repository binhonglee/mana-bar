import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CopilotProbeManager } from '../../src/providers/copilot/probe';
import { CopilotParser } from '../../src/providers/copilot/parse';
import { createTestDeps, type TestDeps } from '../support/copilot-test-utils';
import { COPILOT_EXTENSION_IDS } from '../../src/providers/copilot/types';

const { __testing } = vscode as unknown as { __testing: typeof import('../support/vscode').__testing };

describe('CopilotProbeManager', () => {
	let testDeps: TestDeps;
	let parser: CopilotParser;
	let probeManager: CopilotProbeManager;

	beforeEach(() => {
		__testing.reset();
		testDeps = createTestDeps();
		parser = new CopilotParser(testDeps.deps, testDeps.logParseFailure);
		probeManager = new CopilotProbeManager(
			testDeps.deps,
			parser,
			testDeps.recordSnapshot,
			testDeps.logParseFailure
		);
	});

	afterEach(() => {
		__testing.reset();
		vi.restoreAllMocks();
		testDeps = undefined!;
		parser = undefined!;
		probeManager = undefined!;
	});

	describe('performExportProbe discovering quotaInfo from exports', () => {
		it('calls recordSnapshot when extension exports an object with quotaInfo', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: true,
				exports: {
					quotaInfo: {
						quota: 200,
						used: 50,
						resetDate: '2026-03-10T18:00:00.000Z',
						overageEnabled: false,
						overageUsed: 0,
						unlimited: false,
					},
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(200);
			expect(snapshot.used).toBe(50);
			expect(snapshot.source).toBe('export-probe');
			expect(snapshot.surface).toBe('completions');
		});

		it('normalizes quotaInfo with correct surface for copilot-chat extension', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot-chat',
				isActive: true,
				exports: {
					quotaInfo: {
						quota: 100,
						used: 30,
						resetDate: '2026-04-01T00:00:00.000Z',
						overageEnabled: true,
						overageUsed: 5,
						unlimited: false,
					},
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(100);
			expect(snapshot.used).toBe(30);
			expect(snapshot.surface).toBe('chat');
			expect(snapshot.overageEnabled).toBe(true);
			expect(snapshot.overageUsed).toBe(5);
		});
	});

	describe('performExportProbe discovering quota_snapshots from exports', () => {
		it('calls recordSnapshot when extension exports an object with quota_snapshots', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: true,
				exports: {
					quota_snapshots: {
						premium_interactions: {
							entitlement: 500,
							percent_remaining: 80,
							overage_permitted: false,
							overage_count: 0,
							unlimited: false,
						},
					},
					quota_reset_date: '2026-05-01T00:00:00.000Z',
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(500);
			expect(snapshot.used).toBeCloseTo(500 * (1 - 80 / 100));
			expect(snapshot.source).toBe('export-probe');
			expect(snapshot.overageEnabled).toBe(false);
		});

		it('handles quota_snapshots with chat bucket', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot-chat',
				isActive: true,
				exports: {
					quota_snapshots: {
						chat: {
							entitlement: 300,
							percent_remaining: 60,
							overage_permitted: true,
							overage_count: 3,
							unlimited: false,
						},
					},
					quota_reset_date: '2026-06-01T00:00:00.000Z',
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(300);
			expect(snapshot.used).toBeCloseTo(300 * (1 - 60 / 100));
			expect(snapshot.overageEnabled).toBe(true);
			expect(snapshot.overageUsed).toBe(3);
		});
	});

	describe('performExportProbe calling getAPI(1) method', () => {
		it('calls getAPI(1) and inspects the returned value for quotaInfo', async () => {
			const getAPIMock = vi.fn().mockReturnValue({
				quotaInfo: {
					quota: 150,
					used: 40,
					resetDate: '2026-07-01T00:00:00.000Z',
					overageEnabled: false,
					overageUsed: 0,
					unlimited: false,
				},
			});

			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: true,
				exports: {
					getAPI: getAPIMock,
				},
			});

			await probeManager.performExportProbe('test');

			expect(getAPIMock).toHaveBeenCalledWith(1);
			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(150);
			expect(snapshot.used).toBe(40);
		});

		it('calls getAPI(1) and inspects returned value for quota_snapshots', async () => {
			const getAPIMock = vi.fn().mockReturnValue({
				quota_snapshots: {
					premium_interactions: {
						entitlement: 1000,
						percent_remaining: 50,
						overage_permitted: false,
						overage_count: 0,
						unlimited: false,
					},
				},
				quota_reset_date: '2026-08-01T00:00:00.000Z',
			});

			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: true,
				exports: {
					getAPI: getAPIMock,
				},
			});

			await probeManager.performExportProbe('test');

			expect(getAPIMock).toHaveBeenCalledWith(1);
			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(1000);
			expect(snapshot.used).toBeCloseTo(1000 * (1 - 50 / 100));
		});
	});

	describe('performExportProbe discovering copilotToken.quotaInfo', () => {
		it('calls recordSnapshot when exports contain copilotToken with quotaInfo', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: true,
				exports: {
					copilotToken: {
						quotaInfo: {
							quota: 250,
							used: 75,
							resetDate: '2026-09-01T00:00:00.000Z',
							overageEnabled: true,
							overageUsed: 2,
							unlimited: false,
						},
					},
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(250);
			expect(snapshot.used).toBe(75);
			expect(snapshot.overageEnabled).toBe(true);
			expect(snapshot.overageUsed).toBe(2);
			expect(snapshot.source).toBe('export-probe');
		});

		it('handles nested copilotToken.quotaInfo from copilot-chat extension', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot-chat',
				isActive: true,
				exports: {
					copilotToken: {
						quotaInfo: {
							quota: 400,
							used: 120,
							resetDate: '2026-10-01T00:00:00.000Z',
							overageEnabled: false,
							overageUsed: 0,
							unlimited: false,
						},
					},
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(400);
			expect(snapshot.used).toBe(120);
			expect(snapshot.surface).toBe('chat');
		});
	});

	describe('performExportProbe with no extensions and with activate() errors', () => {
		it('completes without calling recordSnapshot when no extensions are installed', async () => {
			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).not.toHaveBeenCalled();
		});

		it('completes without calling recordSnapshot when non-copilot extensions are installed', async () => {
			__testing.registerExtension({
				id: 'some.other-extension',
				isActive: true,
				exports: {
					quotaInfo: { quota: 100, used: 10 },
				},
			});

			await probeManager.performExportProbe('test');

			expect(testDeps.recordSnapshot).not.toHaveBeenCalled();
		});

		it('logs error and continues when activate() throws', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: false,
				exports: undefined as unknown,
				activate: () => {
					throw new Error('Activation failed');
				},
			});

			// Should not throw
			await expect(probeManager.performExportProbe('test')).resolves.toBeUndefined();
			expect(testDeps.recordSnapshot).not.toHaveBeenCalled();
		});

		it('continues probing other extensions when one activate() throws', async () => {
			__testing.registerExtension({
				id: 'GitHub.copilot',
				isActive: false,
				exports: undefined as unknown,
				activate: () => {
					throw new Error('Activation failed');
				},
			});

			__testing.registerExtension({
				id: 'GitHub.copilot-chat',
				isActive: true,
				exports: {
					quotaInfo: {
						quota: 100,
						used: 20,
						resetDate: '2026-11-01T00:00:00.000Z',
						overageEnabled: false,
						overageUsed: 0,
						unlimited: false,
					},
				},
			});

			await probeManager.performExportProbe('test');

			// Should still record from the second extension
			expect(testDeps.recordSnapshot).toHaveBeenCalled();
			const snapshot = testDeps.recordSnapshot.mock.calls[0][0];
			expect(snapshot.quota).toBe(100);
			expect(snapshot.used).toBe(20);
		});
	});
});
