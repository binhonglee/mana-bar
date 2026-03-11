import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigManager } from '../../src/managers/config-manager';

describe('ConfigManager', () => {
	beforeEach(() => {
		(vscode as any).__testing.reset();
	});

	it('returns the expected defaults', () => {
		const manager = new ConfigManager();

		expect(manager.getPollingInterval()).toBe(120);
		expect(manager.getDisplayMode()).toBe('remaining');
		expect(manager.getStatusBarTooltipLayout()).toBe('regular');
		expect(manager.getDebugLogs()).toBe(false);
		expect(manager.getServicesConfig()).toEqual({
			claudeCode: { enabled: true },
			codex: { enabled: true },
			vscodeCopilot: { enabled: true },
			antigravity: { enabled: true },
			gemini: { enabled: true },
		});
		expect(manager.getHiddenServices()).toEqual([]);
	});

	it('updates service config, display options, and hidden services', async () => {
		const manager = new ConfigManager();

		await manager.updateServiceConfig('gemini', { enabled: true });
		await manager.updateServiceConfig('vscodeCopilot', { enabled: true });
		await manager.updateDisplayMode('remaining');
		await manager.updateStatusBarTooltipLayout('monospaced');
		await manager.updateDebugLogs(true);
		await manager.toggleHideService('Codex');
		await manager.toggleHideService('Codex');
		await manager.toggleHideService('Claude Code');

		expect((vscode as any).__testing.getConfiguration('manaBar', 'services')).toEqual({
			claudeCode: { enabled: true },
			codex: { enabled: true },
			vscodeCopilot: { enabled: true },
			antigravity: { enabled: true },
			gemini: { enabled: true },
		});
		expect(manager.getDisplayMode()).toBe('remaining');
		expect(manager.getStatusBarTooltipLayout()).toBe('monospaced');
		expect(manager.getDebugLogs()).toBe(true);
		expect(manager.getHiddenServices()).toEqual(['Claude Code']);
	});

	it('only fires config change callbacks for the extension section', async () => {
		const callback = vi.fn();
		const manager = new ConfigManager();
		const disposable = manager.onConfigChange(callback);

		await vscode.workspace.getConfiguration('otherSection').update('value', 1, vscode.ConfigurationTarget.Global);
		expect(callback).not.toHaveBeenCalled();

		await vscode.workspace.getConfiguration('manaBar').update('pollingInterval', 120, vscode.ConfigurationTarget.Global);
		expect(callback).toHaveBeenCalledTimes(1);

		disposable.dispose();
	});
});
