import * as path from 'path';
import { pathToFileURL } from 'url';
import { expect, test } from '@playwright/test';
import { serializeServiceSnapshot, serializeUsageData } from '../../src/dashboard-serialization';
import { getServiceDescriptors } from '../../src/services';
import { ServiceSnapshot, UsageData } from '../../src/types';

const HARNESS_HTML = path.resolve(__dirname, 'harness/index.html');

const rawUsageData: UsageData[] = [
	{
		serviceId: 'antigravity',
		serviceName: 'Antigravity Gemini Flash',
		totalUsed: 40,
		totalLimit: 100,
		resetTime: new Date('2026-03-10T12:00:00.000Z'),
		progressSegments: 5,
		models: [
			{ modelName: 'Gemini 2.5 Flash', used: 40, limit: 100, resetTime: new Date('2026-03-10T12:00:00.000Z') },
			{ modelName: 'Gemini 3 Flash Preview', used: 20, limit: 100, resetTime: new Date('2026-03-10T11:30:00.000Z') },
		],
		lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
	},
	{
		serviceId: 'claudeCode',
		serviceName: 'Claude Code',
		totalUsed: 42,
		totalLimit: 100,
		resetTime: new Date('2026-03-15T12:00:00.000Z'),
		quotaWindows: [
			{ label: '5 Hour', used: 30, limit: 100, resetTime: new Date('2026-03-10T12:00:00.000Z') },
			{ label: '7 Day', used: 42, limit: 100, resetTime: new Date('2026-03-15T12:00:00.000Z') },
		],
		models: [],
		lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
	},
	{
		serviceId: 'gemini',
		serviceName: 'Gemini CLI 2.5 Pro',
		totalUsed: 18,
		totalLimit: 100,
		resetTime: new Date('2026-03-10T18:00:00.000Z'),
		models: [
			{ modelName: 'gemini-2.5-pro', used: 18, limit: 100, resetTime: new Date('2026-03-10T18:00:00.000Z') },
		],
		lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
	},
];

const config = {
	displayMode: 'used',
	statusBarTooltipLayout: 'regular',
	debugLogs: false,
	pollingInterval: 60,
	hiddenServices: [],
	services: {
		claudeCode: { enabled: true },
		codex: { enabled: true },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	},
	serviceDescriptors: getServiceDescriptors().map((descriptor) => ({
		id: descriptor.id,
		name: descriptor.name,
		description: descriptor.description,
	})),
};

function serializeUsageSet(
	displayMode: 'used' | 'remaining',
	nextUsageData: UsageData[] = rawUsageData
) {
	return nextUsageData.map((item) => serializeServiceSnapshot(
		{ serviceId: item.serviceId, serviceName: item.serviceName, usage: item },
		displayMode
	));
}

// Kept for tests that still reference the raw usage-data serializer shape directly.
void serializeUsageData;

async function loadHarness(page: import('@playwright/test').Page) {
	await page.goto(pathToFileURL(HARNESS_HTML).href);
	await page.waitForLoadState('load');
}

async function loadHarnessWithMockClock(page: import('@playwright/test').Page, initialNow = '2026-03-10T10:00:00.000Z') {
	await page.addInitScript((initialTimestamp) => {
		const RealDate = Date;
		let now = new RealDate(initialTimestamp).getTime();
		const intervals: Array<{ callback: TimerHandler; delay: number; args: unknown[] }> = [];

		class MockDate extends RealDate {
			constructor(...args: ConstructorParameters<typeof Date>) {
				super(args.length > 0 ? args[0] : now);
			}

			static now() {
				return now;
			}
		}

		MockDate.parse = RealDate.parse;
		MockDate.UTC = RealDate.UTC;
		Object.setPrototypeOf(MockDate, RealDate);
		// @ts-expect-error test harness override
		window.Date = MockDate;

		// @ts-expect-error test harness override
		window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
			intervals.push({ callback, delay: delay ?? 0, args });
			return intervals.length;
		}) as typeof window.setInterval;

		// @ts-expect-error test harness helper
		window.__dashboardTestClock = {
			advance(ms: number) {
				now += ms;
				for (const interval of intervals) {
					if (interval.delay <= ms && typeof interval.callback === 'function') {
						interval.callback(...interval.args);
					}
				}
			},
		};
	}, initialNow);

	await loadHarness(page);
}

async function pushState(
	page: import('@playwright/test').Page,
	nextConfig = config,
	nextUsageData = rawUsageData
) {
	await page.evaluate(([nextConfig, nextUsageData]) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextUsageData);
	}, [nextConfig, serializeUsageSet(nextConfig.displayMode, nextUsageData)]);
}

test('shows the empty state before any usage data arrives', async ({ page }) => {
	await loadHarness(page);

	await expect(page.locator('.service-card')).toHaveCount(0);
	await expect(page.locator('#empty-state')).not.toHaveClass(/hidden/);
});

test('renders usage cards and quota windows from usage updates', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await expect(page.locator('.service-card')).toHaveCount(3);
	await expect(page.locator('.service-card').first().locator('.service-name')).toHaveText('Antigravity Gemini Flash');
	await expect(page.locator('.service-card[data-service="Claude Code"] .quota-window')).toHaveCount(2);
	await expect(page.locator('.service-card[data-service="Claude Code"] .quota-window-label')).toHaveText(['5 Hour', '7 Day']);
});

test('flips values and segmented rings between used and remaining modes', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await expect(page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .progress-value')).toHaveText('18');
	await expect(page.locator('.service-card[data-service="Antigravity Gemini Flash"] .progress-ring-segment-fill.active')).toHaveCount(2);

	await page.evaluate((nextConfig) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextConfig.usageData);
	}, {
		...config,
		displayMode: 'remaining',
		usageData: serializeUsageSet('remaining'),
	});

	await expect(page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .progress-value')).toHaveText('82');
	await expect(page.locator('.service-card[data-service="Antigravity Gemini Flash"] .progress-ring-segment-fill.active')).toHaveCount(3);
});

test('preserves incoming alphabetical order in card rendering', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await expect(page.locator('.service-name')).toHaveText([
		'Antigravity Gemini Flash',
		'Claude Code',
		'Gemini CLI 2.5 Pro',
	]);
});

test('renders hidden services in the hidden section', async ({ page }) => {
	await loadHarness(page);
	await pushState(page, {
		...config,
		hiddenServices: ['Claude Code'],
	});

	await expect(page.locator('#cards-container .service-card')).toHaveCount(2);
	await expect(page.locator('#hidden-section')).toHaveClass('hidden-section');
	await expect(page.locator('#hidden-cards-container .service-card')).toHaveCount(1);
	await expect(page.locator('#hidden-cards-container .service-name')).toHaveText(['Claude Code']);
});

test('persists expanded cards and the active tab across reloads', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await page.click('.service-card[data-service="Antigravity Gemini Flash"] .card-expand-btn');
	await page.click('.tab[data-tab="settings"]');

	await expect(page.locator('.service-card[data-service="Antigravity Gemini Flash"] .card-models')).toHaveClass(/expanded/);
	await expect(page.locator('.tab[data-tab="settings"]')).toHaveClass(/active/);

	const persistedState = await page.evaluate(() => window.__dashboardHarness.getPersistedState());
	expect(persistedState.activeTab).toBe('settings');
	expect(persistedState.expandedCards['Antigravity Gemini Flash']).toBe(true);

	await page.reload();
	await page.waitForLoadState('load');

	await expect(page.locator('.tab[data-tab="settings"]')).toHaveClass(/active/);
	await expect(page.locator('.service-card[data-service="Antigravity Gemini Flash"] .card-models')).toHaveClass(/expanded/);
});

test('updates cards in place when the layout is stable and rebuilds when the layout changes', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await page.evaluate(() => {
		// @ts-expect-error test-only handle
		window.__originalGeminiCard = document.querySelector('.service-card[data-service="Gemini CLI 2.5 Pro"]');
	});

	await page.evaluate((nextUsageData) => {
		window.__dashboardHarness.dispatchUsageUpdate(nextUsageData);
	}, serializeUsageSet('used', rawUsageData.map(item => item.serviceName === 'Gemini CLI 2.5 Pro'
		? {
			...item,
			totalUsed: 27,
			models: [
				{ modelName: 'gemini-2.5-pro', used: 27, limit: 100, resetTime: new Date('2026-03-10T18:00:00.000Z') },
			],
		}
		: item)));

	await expect(page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .progress-value')).toHaveText('27');
	await expect(page.evaluate(() => {
		// @ts-expect-error test-only handle
		return window.__originalGeminiCard === document.querySelector('.service-card[data-service="Gemini CLI 2.5 Pro"]');
	})).resolves.toBe(true);

	await page.evaluate((nextUsageData) => {
		window.__dashboardHarness.dispatchUsageUpdate(nextUsageData);
	}, serializeUsageSet('used', rawUsageData.map(item => item.serviceName === 'Gemini CLI 2.5 Pro'
		? {
			...item,
			quotaWindows: [
				{ label: '1 Hour', used: 27, limit: 100, resetTime: new Date('2026-03-10T11:00:00.000Z') },
				{ label: '1 Day', used: 45, limit: 100, resetTime: new Date('2026-03-11T10:00:00.000Z') },
			],
			models: [],
		}
		: item)));

	await expect(page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .quota-window')).toHaveCount(2);
	await expect(page.evaluate(() => {
		// @ts-expect-error test-only handle
		return window.__originalGeminiCard !== document.querySelector('.service-card[data-service="Gemini CLI 2.5 Pro"]');
	})).resolves.toBe(true);
});

test('updates reset countdown labels when the periodic timer runs', async ({ page }) => {
	await loadHarnessWithMockClock(page);
	await pushState(page);

	const resetLocator = page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .card-details .reset-time');
	await expect(resetLocator).toHaveText('8h 0m');

	await page.evaluate(() => {
		// @ts-expect-error browser test clock helper
		window.__dashboardTestClock.advance(30 * 60 * 1000);
	});

	await expect(resetLocator).toHaveText('7h 30m');
});

test('posts hide and settings actions back through the vscode bridge', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);
	await page.evaluate(() => window.__dashboardHarness.clearPostedMessages());

	await page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .card-hide-btn').evaluate((element: HTMLButtonElement) => {
		element.click();
	});
	await page.click('.tab[data-tab="settings"]');
	await page.selectOption('#display-mode-select', 'remaining');
	await page.selectOption('#status-bar-tooltip-layout-select', 'monospaced');
	await page.locator('#debug-logs-toggle').evaluate((element: HTMLInputElement) => {
		element.checked = true;
		element.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.locator('input[data-service="gemini"]').evaluate((element: HTMLInputElement) => {
		element.checked = false;
		element.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.locator('#polling-slider').evaluate((element: HTMLInputElement) => {
		element.value = '120';
		element.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(600);

	const messages = await page.evaluate(() => window.__dashboardHarness.getPostedMessages());
	expect(messages).toEqual([
		{ type: 'toggleHideService', service: 'Gemini CLI 2.5 Pro' },
		{ type: 'setDisplayMode', mode: 'remaining' },
		{ type: 'setStatusBarTooltipLayout', layout: 'monospaced' },
		{ type: 'setDebugLogs', enabled: true },
		{ type: 'toggleService', service: 'gemini', enabled: false },
		{ type: 'setPollingInterval', interval: 120 },
	]);
});
test('renders the VSCode Copilot toggle in settings', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);
	await page.click('.tab[data-tab="settings"]');

	await expect(page.locator('input[data-service="vscodeCopilot"]')).toHaveCount(1);
	await expect(page.locator('.service-toggle-card')).toContainText(['VSCode Copilot']);
	await expect(page.locator('#debug-logs-toggle')).toHaveCount(1);
});

// Outage UI tests
const sampleOutages = [
	{
		issueNumber: 123,
		issueUrl: 'https://github.com/test/repo/issues/123',
		title: '[Outage] Claude Code - claude-sonnet-4-6',
		service: 'Claude Code',
		model: 'claude-sonnet-4-6',
		reactionCount: 5,
		verified: true,
		createdAt: '2026-03-10T09:00:00.000Z',
	},
	{
		issueNumber: 124,
		issueUrl: 'https://github.com/test/repo/issues/124',
		title: '[Outage] Gemini CLI 2.5 Pro',
		service: 'Gemini CLI 2.5 Pro',
		reactionCount: 2,
		verified: false,
		createdAt: '2026-03-10T08:00:00.000Z',
	},
];

test('renders outage items when outages exist in status tab', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	// Dispatch outage update
	await page.evaluate((outages) => {
		window.__dashboardHarness.dispatchOutageUpdate(outages);
	}, sampleOutages);

	// Switch to status tab
	await page.click('.tab[data-tab="status"]');

	// Verify outages are rendered
	await expect(page.locator('.outage-item')).toHaveCount(2);
	await expect(page.locator('#outages-empty-state')).toHaveClass(/hidden/);
});

test('renders verified and unverified outage badges correctly', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await page.evaluate((outages) => {
		window.__dashboardHarness.dispatchOutageUpdate(outages);
	}, sampleOutages);

	await page.click('.tab[data-tab="status"]');

	// Check verified badge
	await expect(page.locator('.status-badge.verified')).toHaveCount(1);
	await expect(page.locator('.status-badge.verified')).toContainText('Confirmed');

	// Check unverified badge
	await expect(page.locator('.status-badge.unverified')).toHaveCount(1);
	await expect(page.locator('.status-badge.unverified')).toContainText('Unverified');
});

test('report outage button posts correct message', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);
	await page.evaluate(() => window.__dashboardHarness.clearPostedMessages());

	await page.click('.tab[data-tab="status"]');
	await page.click('#report-outage-btn');

	const messages = await page.evaluate(() => window.__dashboardHarness.getPostedMessages());
	expect(messages).toContainEqual({ type: 'reportOutage' });
});

test('view on GitHub button posts correct message', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	await page.evaluate((outages) => {
		window.__dashboardHarness.dispatchOutageUpdate(outages);
	}, sampleOutages);

	await page.click('.tab[data-tab="status"]');
	await page.evaluate(() => window.__dashboardHarness.clearPostedMessages());

	// Click the first "View on GitHub" button
	await page.locator('.outage-view-btn').first().click();

	const messages = await page.evaluate(() => window.__dashboardHarness.getPostedMessages());
	expect(messages).toContainEqual({ type: 'openOutageUrl', url: 'https://github.com/test/repo/issues/123' });
});

test('renders outage indicator on service card when outage exists', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	// Add outage for Claude Code
	await page.evaluate((outages) => {
		window.__dashboardHarness.dispatchOutageUpdate(outages);
	}, [sampleOutages[0]]);

	// Check that the outage indicator appears on the Claude Code card
	await expect(page.locator('.service-card[data-service="Claude Code"] .card-outage-indicator')).toHaveCount(1);
	await expect(page.locator('.service-card[data-service="Claude Code"] .card-outage-indicator')).toContainText('1 outage');
});

test('shows empty state when no outages exist', async ({ page }) => {
	await loadHarness(page);
	await pushState(page);

	// Dispatch empty outage update
	await page.evaluate(() => {
		window.__dashboardHarness.dispatchOutageUpdate([]);
	});

	await page.click('.tab[data-tab="status"]');

	// Verify empty state is shown
	await expect(page.locator('#outages-empty-state')).not.toHaveClass(/hidden/);
	await expect(page.locator('.outage-item')).toHaveCount(0);
});

// Edge case tests - use real service IDs to avoid descriptor lookup errors
test('handles zero limit edge case gracefully', async ({ page }) => {
	await loadHarness(page);

	const zeroLimitData: UsageData[] = [
		{
			serviceId: 'gemini',
			serviceName: 'Gemini CLI 2.5 Pro',
			totalUsed: 0,
			totalLimit: 0,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			models: [],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	];

	await pushState(page, config, zeroLimitData);

	// Should render without crashing
	await expect(page.locator('.service-card')).toHaveCount(1);
	// Progress value should show 0 (not NaN or Infinity)
	await expect(page.locator('.service-card .progress-value')).toHaveText('0');
});

test('handles empty quota windows array', async ({ page }) => {
	await loadHarness(page);

	const emptyQuotaData: UsageData[] = [
		{
			serviceId: 'gemini',
			serviceName: 'Gemini CLI 2.5 Pro',
			totalUsed: 50,
			totalLimit: 100,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			quotaWindows: [],
			models: [],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	];

	await pushState(page, config, emptyQuotaData);

	// Should render without crashing
	await expect(page.locator('.service-card')).toHaveCount(1);
	// Should not have any quota windows
	await expect(page.locator('.service-card .quota-window')).toHaveCount(0);
});

test('handles service with only models (no quota windows)', async ({ page }) => {
	await loadHarness(page);

	const modelsOnlyData: UsageData[] = [
		{
			serviceId: 'antigravity',
			serviceName: 'Antigravity Gemini Flash',
			totalUsed: 30,
			totalLimit: 100,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			models: [
				{ modelName: 'model-a', used: 20, limit: 50, resetTime: new Date('2026-03-10T12:00:00.000Z') },
				{ modelName: 'model-b', used: 10, limit: 50, resetTime: new Date('2026-03-10T12:00:00.000Z') },
			],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	];

	await pushState(page, config, modelsOnlyData);

	await expect(page.locator('.service-card')).toHaveCount(1);
	// Expand the card to see models
	await page.click('.service-card .card-expand-btn');
	await expect(page.locator('.service-card .model-row')).toHaveCount(2);
});

test('handles 100% usage display correctly', async ({ page }) => {
	await loadHarness(page);

	const fullUsageData: UsageData[] = [
		{
			serviceId: 'gemini',
			serviceName: 'Gemini CLI 2.5 Pro',
			totalUsed: 100,
			totalLimit: 100,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			models: [],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	];

	await pushState(page, config, fullUsageData);

	await expect(page.locator('.service-card')).toHaveCount(1);
	await expect(page.locator('.service-card .progress-value')).toHaveText('100');
});

test('handles remaining mode with 100% usage', async ({ page }) => {
	await loadHarness(page);

	const fullUsageData: UsageData[] = [
		{
			serviceId: 'gemini',
			serviceName: 'Gemini CLI 2.5 Pro',
			totalUsed: 100,
			totalLimit: 100,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			models: [],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	];

	await pushState(page, { ...config, displayMode: 'remaining' }, fullUsageData);

	await expect(page.locator('.service-card')).toHaveCount(1);
	// Remaining should be 0 when at 100% usage
	await expect(page.locator('.service-card .progress-value')).toHaveText('0');
});

test('renders Cursor-like quota windows with Spend and percentage buckets', async ({ page }) => {
	await loadHarness(page);

	// Cursor with hasAutoSpillover shows: Spend (dollars) + Auto + API (percentages)
	const cursorUsageData: UsageData[] = [
		{
			serviceId: 'cursor',
			serviceName: 'Cursor',
			totalUsed: 42, // Critical percentage
			totalLimit: 100,
			resetTime: new Date('2026-04-01T00:00:00.000Z'),
			quotaWindows: [
				{ label: 'Spend', used: 3, limit: 20 }, // Dollar-based
				{ label: 'Auto + Composer', used: 42, limit: 100 },
				{ label: 'API', used: 15, limit: 100 },
			],
			models: [],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	];

	await pushState(page, config, cursorUsageData);

	await expect(page.locator('.service-card')).toHaveCount(1);
	await expect(page.locator('.service-card .quota-window')).toHaveCount(3);

	// Verify all three labels are present
	const labels = page.locator('.service-card .quota-window-label');
	await expect(labels.nth(0)).toHaveText('Spend');
	await expect(labels.nth(1)).toHaveText('Auto + Composer');
	await expect(labels.nth(2)).toHaveText('API');

	// Verify Spend shows dollar format (3/20), not percentage
	const values = page.locator('.service-card .quota-window-value');
	await expect(values.nth(0)).toHaveText('3/20');
	await expect(values.nth(1)).toHaveText('42%');
	await expect(values.nth(2)).toHaveText('15%');
});

function serializeSnapshotSet(
	displayMode: 'used' | 'remaining',
	snapshots: ServiceSnapshot[]
) {
	return snapshots.map((snapshot) => serializeServiceSnapshot(snapshot, displayMode));
}

test('renders a health-only service card with reauth state and no usage metrics', async ({ page }) => {
	await loadHarness(page);

	const snapshots: ServiceSnapshot[] = [
		{
			serviceId: 'kiro',
			serviceName: 'Kiro',
			health: {
				kind: 'reauthRequired',
				summary: 'Kiro credentials expired',
				detail: 'Run `kiro login` to refresh the token.',
				lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			},
		},
	];

	await page.evaluate(([nextConfig, nextSnapshots]) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextSnapshots);
	}, [config, serializeSnapshotSet(config.displayMode as 'used' | 'remaining', snapshots)]);

	const card = page.locator('.service-card[data-service="Kiro"]');
	await expect(card).toHaveCount(1);
	await expect(card).toHaveClass(/health-only/);
	await expect(card).toHaveClass(/status-warning/);
	await expect(card.locator('.progress-value')).toHaveCount(0);
	await expect(card.locator('.quota-window')).toHaveCount(0);

	const healthBlock = card.locator('.card-health');
	await expect(healthBlock).toHaveAttribute('data-health-kind', 'reauthRequired');
	await expect(healthBlock.locator('.card-health-label')).toHaveText('Reauth needed');
	await expect(healthBlock.locator('.card-health-summary')).toHaveText('Kiro credentials expired');
	await expect(healthBlock.locator('.card-health-detail')).toHaveText('Run `kiro login` to refresh the token.');
});

test('rebuilds a service card when it transitions from usage to health-only', async ({ page }) => {
	await loadHarness(page);

	const usageSnapshot: ServiceSnapshot = {
		serviceId: 'kiro',
		serviceName: 'Kiro',
		usage: {
			serviceId: 'kiro',
			serviceName: 'Kiro',
			totalUsed: 120,
			totalLimit: 200,
			resetTime: new Date('2026-03-10T12:00:00.000Z'),
			models: [],
			lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
		},
	};

	await page.evaluate(([nextConfig, nextSnapshots]) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextSnapshots);
	}, [config, serializeSnapshotSet('used', [usageSnapshot])]);

	const card = page.locator('.service-card[data-service="Kiro"]');
	await expect(card).toHaveCount(1);
	await expect(card).not.toHaveClass(/health-only/);
	await expect(card.locator('.progress-value')).toHaveText('120');

	const healthSnapshot: ServiceSnapshot = {
		serviceId: 'kiro',
		serviceName: 'Kiro',
		health: {
			kind: 'reauthRequired',
			summary: 'Kiro credentials expired',
			lastUpdated: new Date('2026-03-10T10:05:00.000Z'),
		},
	};

	await page.evaluate((nextSnapshots) => {
		window.__dashboardHarness.dispatchUsageUpdate(nextSnapshots);
	}, serializeSnapshotSet('used', [healthSnapshot]));

	await expect(card).toHaveClass(/health-only/);
	await expect(card.locator('.progress-value')).toHaveCount(0);
	await expect(card.locator('.card-health-label')).toHaveText('Reauth needed');
	await expect(card.locator('.card-health-summary')).toHaveText('Kiro credentials expired');
	await expect(card.locator('.card-health-detail')).toHaveCount(0);
});

test('renders an unavailable health-only card with critical status', async ({ page }) => {
	await loadHarness(page);

	const snapshots: ServiceSnapshot[] = [
		{
			serviceId: 'kiro',
			serviceName: 'Kiro',
			health: {
				kind: 'unavailable',
				summary: 'Kiro API is unreachable',
				lastUpdated: new Date('2026-03-10T10:00:00.000Z'),
			},
		},
	];

	await page.evaluate(([nextConfig, nextSnapshots]) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextSnapshots);
	}, [config, serializeSnapshotSet('used', snapshots)]);

	const card = page.locator('.service-card[data-service="Kiro"]');
	await expect(card).toHaveClass(/health-only/);
	await expect(card).toHaveClass(/status-critical/);
	await expect(card.locator('.card-health').first()).toHaveAttribute('data-health-kind', 'unavailable');
	await expect(card.locator('.card-health-label')).toHaveText('Unavailable');
});
