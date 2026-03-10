import * as path from 'path';
import { pathToFileURL } from 'url';
import { expect, test } from '@playwright/test';

const HARNESS_HTML = path.resolve(__dirname, 'harness/index.html');

const usageData = [
	{
		serviceName: 'Antigravity Gemini Flash',
		totalUsed: 40,
		totalLimit: 100,
		resetTime: '2026-03-10T12:00:00.000Z',
		progressSegments: 5,
		models: [
			{ modelName: 'Gemini 2.5 Flash', used: 40, limit: 100, resetTime: '2026-03-10T12:00:00.000Z' },
			{ modelName: 'Gemini 3 Flash Preview', used: 20, limit: 100, resetTime: '2026-03-10T11:30:00.000Z' },
		],
		lastUpdated: '2026-03-10T10:00:00.000Z',
	},
	{
		serviceName: 'Claude Code',
		totalUsed: 42,
		totalLimit: 100,
		resetTime: '2026-03-15T12:00:00.000Z',
		quotaWindows: [
			{ label: '5 Hour', used: 30, limit: 100, resetTime: '2026-03-10T12:00:00.000Z' },
			{ label: '7 Day', used: 42, limit: 100, resetTime: '2026-03-15T12:00:00.000Z' },
		],
		models: [],
		lastUpdated: '2026-03-10T10:00:00.000Z',
	},
	{
		serviceName: 'Gemini CLI 2.5 Pro',
		totalUsed: 18,
		totalLimit: 100,
		resetTime: '2026-03-10T18:00:00.000Z',
		models: [
			{ modelName: 'gemini-2.5-pro', used: 18, limit: 100, resetTime: '2026-03-10T18:00:00.000Z' },
		],
		lastUpdated: '2026-03-10T10:00:00.000Z',
	},
];

const config = {
	displayMode: 'used',
	statusBarTooltipLayout: 'regular',
	pollingInterval: 60,
	hiddenServices: [],
	services: {
		claudeCode: { enabled: true },
		codex: { enabled: true },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	},
};

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
	nextUsageData = usageData
) {
	await page.evaluate(([nextConfig, nextUsageData]) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextUsageData);
	}, [nextConfig, nextUsageData]);
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
	}, {
		...config,
		displayMode: 'remaining',
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
	}, usageData.map(item => item.serviceName === 'Gemini CLI 2.5 Pro'
		? {
			...item,
			totalUsed: 27,
			models: [
				{ modelName: 'gemini-2.5-pro', used: 27, limit: 100, resetTime: '2026-03-10T18:00:00.000Z' },
			],
		}
		: item));

	await expect(page.locator('.service-card[data-service="Gemini CLI 2.5 Pro"] .progress-value')).toHaveText('27');
	await expect(page.evaluate(() => {
		// @ts-expect-error test-only handle
		return window.__originalGeminiCard === document.querySelector('.service-card[data-service="Gemini CLI 2.5 Pro"]');
	})).resolves.toBe(true);

	await page.evaluate((nextUsageData) => {
		window.__dashboardHarness.dispatchUsageUpdate(nextUsageData);
	}, usageData.map(item => item.serviceName === 'Gemini CLI 2.5 Pro'
		? {
			...item,
			quotaWindows: [
				{ label: '1 Hour', used: 27, limit: 100, resetTime: '2026-03-10T11:00:00.000Z' },
				{ label: '1 Day', used: 45, limit: 100, resetTime: '2026-03-11T10:00:00.000Z' },
			],
			models: [],
		}
		: item));

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
		{ type: 'toggleService', service: 'gemini', enabled: false },
		{ type: 'setPollingInterval', interval: 120 },
	]);
});
