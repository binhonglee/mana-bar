import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'binhonglee.mana-bar';

interface Snapshot {
	providerNames: string[];
	usageData: Array<{
		serviceName: string;
		totalUsed: number;
		totalLimit: number;
	}>;
	displayMode: string;
	dashboard: {
		isOpen: boolean;
		createCount: number;
	};
	scenarioIndex: number;
}

async function waitFor<T>(
	description: string,
	callback: () => Promise<T | undefined>,
	isDone: (value: T | undefined) => boolean,
	timeoutMs = 10000
): Promise<T> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const value = await callback();
		if (isDone(value)) {
			return value as T;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}

	throw new Error(`Timed out waiting for ${description}`);
}

async function getSnapshot(): Promise<Snapshot> {
	const snapshot = await vscode.commands.executeCommand<Snapshot>('manaBar.__test.getSnapshot');
	assert.ok(snapshot, 'expected test snapshot command to return data');
	return snapshot;
}

async function updateConfig(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration('manaBar').update(
		key,
		value,
		vscode.ConfigurationTarget.Global
	);
}

async function activateExtension(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `extension ${EXTENSION_ID} should exist`);
	await extension.activate();
}

async function enableAllServices(): Promise<void> {
	await updateConfig('services', {
		claudeCode: { enabled: true },
		codex: { enabled: true },
		cursor: { enabled: true },
		kiro: { enabled: true },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	});
}

async function resetConfig(): Promise<void> {
	await updateConfig('services', {
		claudeCode: { enabled: true },
		codex: { enabled: true },
		cursor: { enabled: true },
		kiro: { enabled: true },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	});
	await updateConfig('hiddenServices', []);
	await updateConfig('displayMode', 'used');
}

async function testActivationAndSnapshot() {
	const snapshot = await waitFor(
		'test snapshot command',
		() => getSnapshot().catch(() => undefined),
		Boolean
	);

	assert.deepStrictEqual(snapshot.providerNames, [
		'Antigravity Gemini Flash',
		'Claude Code',
		'Codex',
		'Cursor',
		'Gemini CLI 2.5 Pro',
		'Kiro',
	]);
}

async function testRefreshAdvancesFakeScenario() {
	await enableAllServices();

	const initial = await waitFor(
		'initial usage data',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.usageData.length === 6 && snapshot.scenarioIndex === 0
	);
	assert.strictEqual(initial.usageData.find(item => item.serviceName === 'Claude Code')?.totalUsed, 42);
	assert.strictEqual(initial.usageData.find(item => item.serviceName === 'Cursor')?.totalUsed, 42);
	assert.strictEqual(initial.usageData.find(item => item.serviceName === 'Kiro')?.totalUsed, 120.2);

	await vscode.commands.executeCommand('manaBar.refresh');

	const refreshed = await waitFor(
		'refreshed usage data',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.scenarioIndex === 1
	);
	assert.strictEqual(refreshed.usageData.find(item => item.serviceName === 'Claude Code')?.totalUsed, 67);
	assert.strictEqual(refreshed.usageData.find(item => item.serviceName === 'Cursor')?.totalUsed, 68);
	assert.strictEqual(refreshed.usageData.find(item => item.serviceName === 'Kiro')?.totalUsed, 245.8);
	assert.strictEqual(refreshed.usageData.find(item => item.serviceName === 'Gemini CLI 2.5 Pro')?.totalUsed, 27);
}

async function testDashboardReuse() {
	await vscode.commands.executeCommand('manaBar.openDashboard');
	await vscode.commands.executeCommand('manaBar.openDashboard');

	const snapshot = await waitFor(
		'dashboard open state',
		() => getSnapshot(),
		result => result !== undefined && result.dashboard.isOpen
	);

	assert.strictEqual(snapshot.dashboard.isOpen, true);
	assert.strictEqual(snapshot.dashboard.createCount, 1);
}

async function testDisplayModeUpdates() {
	await updateConfig('displayMode', 'remaining');

	const snapshot = await waitFor(
		'display mode update',
		() => getSnapshot(),
		result => result !== undefined && result.displayMode === 'remaining'
	);

	assert.strictEqual(snapshot.displayMode, 'remaining');
}

async function testServiceToggleDisable() {
	// Start with all services enabled
	await enableAllServices();

	// Verify codex is initially in the usage data
	const initial = await waitFor(
		'initial state with codex enabled',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.usageData.some(item => item.serviceName === 'Codex')
	);
	assert.ok(initial.usageData.some(item => item.serviceName === 'Codex'), 'Codex should be in initial usage data');

	// Disable codex
	await updateConfig('services', {
		claudeCode: { enabled: true },
		codex: { enabled: false },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	});

	// Verify codex is no longer in the usage data
	const afterDisable = await waitFor(
		'codex disabled state',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && !snapshot.usageData.some(item => item.serviceName === 'Codex')
	);
	assert.ok(!afterDisable.usageData.some(item => item.serviceName === 'Codex'), 'Codex should not be in usage data after disable');
}

async function testServiceToggleEnable() {
	// Start with codex disabled
	await updateConfig('services', {
		claudeCode: { enabled: true },
		codex: { enabled: false },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	});

	// Verify codex is not in the usage data
	const initial = await waitFor(
		'initial state with codex disabled',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && !snapshot.usageData.some(item => item.serviceName === 'Codex')
	);
	assert.ok(!initial.usageData.some(item => item.serviceName === 'Codex'), 'Codex should not be in initial usage data');

	// Enable codex
	await updateConfig('services', {
		claudeCode: { enabled: true },
		codex: { enabled: true },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	});

	// Verify codex appears in the usage data
	const afterEnable = await waitFor(
		'codex enabled state',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.usageData.some(item => item.serviceName === 'Codex')
	);
	assert.ok(afterEnable.usageData.some(item => item.serviceName === 'Codex'), 'Codex should be in usage data after enable');
}

async function testPartialProvidersRender() {
	// Test that the extension renders correctly with only a subset of providers enabled
	// This verifies resilience when some services are unavailable
	await updateConfig('services', {
		claudeCode: { enabled: false },
		codex: { enabled: false },
		cursor: { enabled: true },
		kiro: { enabled: true },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: false },
		gemini: { enabled: false },
	});

	// Should only have Cursor and Kiro
	const snapshot = await waitFor(
		'partial providers state',
		() => getSnapshot(),
		s => s !== undefined && s.usageData.length === 2
	);
	assert.strictEqual(snapshot.usageData.length, 2);
	assert.ok(snapshot.usageData.some(item => item.serviceName === 'Cursor'), 'Cursor should be present');
	assert.ok(snapshot.usageData.some(item => item.serviceName === 'Kiro'), 'Kiro should be present');

	// Open dashboard - should render without errors
	await vscode.commands.executeCommand('manaBar.openDashboard');

	const afterDashboard = await waitFor(
		'dashboard open with partial providers',
		() => getSnapshot(),
		s => s !== undefined && s.dashboard.isOpen
	);
	assert.strictEqual(afterDashboard.dashboard.isOpen, true);
}

async function testSingleProviderRender() {
	// Test rendering with only one provider - edge case for layout
	await updateConfig('services', {
		claudeCode: { enabled: false },
		codex: { enabled: false },
		cursor: { enabled: true },
		kiro: { enabled: false },
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: false },
		gemini: { enabled: false },
	});

	const snapshot = await waitFor(
		'single provider state',
		() => getSnapshot(),
		s => s !== undefined && s.usageData.length === 1
	);
	assert.strictEqual(snapshot.usageData.length, 1);
	assert.strictEqual(snapshot.usageData[0].serviceName, 'Cursor');

	// Open dashboard with single service
	await vscode.commands.executeCommand('manaBar.openDashboard');

	const afterDashboard = await waitFor(
		'dashboard open with single provider',
		() => getSnapshot(),
		s => s !== undefined && s.dashboard.isOpen
	);
	assert.strictEqual(afterDashboard.dashboard.isOpen, true);
}

async function testHiddenServicesFilter() {
	// Start with default config (all visible)
	await resetConfig();

	// Verify Claude Code is in the usage data
	const initial = await waitFor(
		'initial state with all visible',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.usageData.some(item => item.serviceName === 'Claude Code')
	);
	assert.ok(initial.usageData.some(item => item.serviceName === 'Claude Code'), 'Claude Code should be in initial usage data');

	// Add Claude Code to hidden services
	await updateConfig('hiddenServices', ['Claude Code']);

	// The service should still be in usageData (it's hidden, not disabled)
	// hiddenServices only affects UI display filtering, not the underlying data
	const afterHide = await waitFor(
		'Claude Code still in data after hide',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.usageData.length > 0
	);
	// Hidden services should still be present in the raw data
	assert.ok(afterHide.usageData.some(item => item.serviceName === 'Claude Code'),
		'Claude Code should still be in usageData (hidden services only filter UI display)');
}

export async function run(): Promise<void> {
	await activateExtension();
	await resetConfig();

	try {
		await testActivationAndSnapshot();
		await testRefreshAdvancesFakeScenario();
		await testDashboardReuse();
		await testDisplayModeUpdates();
		await testServiceToggleDisable();
		await testServiceToggleEnable();
		await testPartialProvidersRender();
		await testSingleProviderRender();
		await testHiddenServicesFilter();
	} finally {
		await resetConfig();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	}
}
