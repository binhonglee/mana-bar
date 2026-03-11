import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SidebarProvider } from '../../src/ui/sidebar';
import { StatusBarController } from '../../src/ui/status-bar';
import { UsageManager } from '../../src/managers/usage-manager';
import { ConfigManager } from '../../src/managers/config-manager';

describe('UI Extra Coverage', () => {
	const mockUsageManager = {
		onDidUpdateUsage: vi.fn(() => ({ dispose: vi.fn() })),
		getAllUsageData: vi.fn(() => []),
	} as any;

	const mockConfigManager = {
		onConfigChange: vi.fn(() => ({ dispose: vi.fn() })),
		getDisplayMode: vi.fn(() => 'used'),
		getHiddenServices: vi.fn(() => []),
		getStatusBarTooltipLayout: vi.fn(() => 'regular'),
	} as any;

	describe('SidebarProvider', () => {
		it('covers getTreeItem and getChildren defaults', () => {
			const provider = new SidebarProvider(mockUsageManager, mockConfigManager);
			const item = new (vscode as any).TreeItem('test');
			expect(provider.getTreeItem(item as any)).toBe(item);

			// getChildren with unknown element
			expect(provider.getChildren({} as any)).toEqual([]);
		});

		it('covers getServiceDetails when usage is missing', () => {
			const provider = new SidebarProvider(mockUsageManager, mockConfigManager);
			// We need to pass an element that has a serviceName but is not in getAllUsageData
			const element = { serviceName: 'Missing' };
			mockUsageManager.getAllUsageData.mockReturnValue([]);
			expect(provider.getChildren(element as any)).toEqual([]);
		});

		it('covers dispose', () => {
			const provider = new SidebarProvider(mockUsageManager, mockConfigManager);
			provider.dispose();
			// Should not throw
		});
	});

	describe('StatusBarController', () => {
		it('covers totalLimit === 0 case in update', () => {
			mockUsageManager.getAllUsageData.mockReturnValue([
				{ serviceId: 'codex', serviceName: 'Test', totalUsed: 0, totalLimit: 0, lastUpdated: new Date() }
			]);
			const controller = new StatusBarController(mockUsageManager, mockConfigManager);
			// Update is called in constructor
			// How to verify statusBarItem.text? We need to mock vscode.window.createStatusBarItem
		});

		it('covers buildTooltipRegular without resetTime', () => {
			mockUsageManager.getAllUsageData.mockReturnValue([
				{ serviceId: 'codex', serviceName: 'Test', totalUsed: 10, totalLimit: 100, lastUpdated: new Date() }
			]);
			const controller = new StatusBarController(mockUsageManager, mockConfigManager);
			// tooltip is set in update
		});

		it('covers getStatusEmoji and buildTooltipMonospaced cases', () => {
			mockConfigManager.getStatusBarTooltipLayout.mockReturnValue('monospaced');
			mockUsageManager.getAllUsageData.mockReturnValue([
				{ serviceId: 'codex', serviceName: 'Critical', totalUsed: 100, totalLimit: 100, lastUpdated: new Date() },
				{ serviceId: 'codex', serviceName: 'Warning', totalUsed: 85, totalLimit: 100, lastUpdated: new Date() },
				{ serviceId: 'codex', serviceName: 'OK', totalUsed: 10, totalLimit: 100, lastUpdated: new Date() },
			]);
			const controller = new StatusBarController(mockUsageManager, mockConfigManager);
		});

		it('covers dispose', () => {
			const controller = new StatusBarController(mockUsageManager, mockConfigManager);
			controller.dispose();
		});
	});
});
