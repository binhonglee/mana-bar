import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'llm-usage-tracker.llm-usage-tracker';

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
	const snapshot = await vscode.commands.executeCommand<Snapshot>('llmUsageTracker.__test.getSnapshot');
	assert.ok(snapshot, 'expected test snapshot command to return data');
	return snapshot;
}

async function updateConfig(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration('llmUsageTracker').update(
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
		vscodeCopilot: { enabled: false },
		antigravity: { enabled: true },
		gemini: { enabled: true },
	});
}

async function resetConfig(): Promise<void> {
	await updateConfig('services', {
		claudeCode: { enabled: true },
		codex: { enabled: true },
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
		'Gemini CLI 2.5 Pro',
	]);
}

async function testRefreshAdvancesFakeScenario() {
	await enableAllServices();

	const initial = await waitFor(
		'initial usage data',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.usageData.length === 4 && snapshot.scenarioIndex === 0
	);
	assert.strictEqual(initial.usageData.find(item => item.serviceName === 'Claude Code')?.totalUsed, 42);

	await vscode.commands.executeCommand('llmUsageTracker.refresh');

	const refreshed = await waitFor(
		'refreshed usage data',
		() => getSnapshot(),
		snapshot => snapshot !== undefined && snapshot.scenarioIndex === 1
	);
	assert.strictEqual(refreshed.usageData.find(item => item.serviceName === 'Claude Code')?.totalUsed, 67);
	assert.strictEqual(refreshed.usageData.find(item => item.serviceName === 'Gemini CLI 2.5 Pro')?.totalUsed, 27);
}

async function testDashboardReuse() {
	await vscode.commands.executeCommand('llmUsageTracker.openDashboard');
	await vscode.commands.executeCommand('llmUsageTracker.openDashboard');

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

export async function run(): Promise<void> {
	await activateExtension();
	await resetConfig();

	try {
		await testActivationAndSnapshot();
		await testRefreshAdvancesFakeScenario();
		await testDashboardReuse();
		await testDisplayModeUpdates();
	} finally {
		await updateConfig('displayMode', 'used');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	}
}
