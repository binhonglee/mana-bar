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

async function pushState(page: import('@playwright/test').Page) {
	await page.evaluate(([nextConfig, nextUsageData]) => {
		window.__dashboardHarness.dispatchConfigUpdate(nextConfig);
		window.__dashboardHarness.dispatchUsageUpdate(nextUsageData);
	}, [config, usageData]);
}

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
