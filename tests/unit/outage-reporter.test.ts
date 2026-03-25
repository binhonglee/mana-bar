import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutageReporter } from '../../src/outage/outage-reporter';
import { OutageClient } from '../../src/outage/outage-client';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';

// Mock VS Code API
vi.mock('vscode', () => ({
    window: {
        showQuickPick: vi.fn(),
        showInformationMessage: vi.fn(),
        withProgress: vi.fn((options, callback) => callback({ report: vi.fn() }, { isCancellationRequested: false }))
    },
    env: {
        openExternal: vi.fn()
    },
    Uri: {
        parse: vi.fn((url) => url)
    },
    ProgressLocation: {
        Notification: 'Notification'
    }
}));

// Mock fs
vi.mock('fs/promises', () => ({
    readFile: vi.fn()
}));

// Mock the OutageClient
const MockOutageClient = vi.fn(() => ({
    findExistingOutage: vi.fn()
}));

describe('OutageReporter', () => {
    let reporter: OutageReporter;
    let mockClient: any;
    let mockRunner: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = new MockOutageClient();
        mockClient.findExistingOutage.mockReset();
        
        mockRunner = {
            run: vi.fn()
        };
        reporter = new OutageReporter(mockClient, { commandRunner: mockRunner });
    });

    describe('reportOutage', () => {
        it('should cancel if user aborts service selection', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
            
            await reporter.reportOutage();
            
            expect(vscode.window.withProgress).not.toHaveBeenCalled();
        });

        it('should probe Claude models and construct correct issue URL with full model ID', async () => {
            // Select Claude Code
            vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
                label: 'Claude Code',
                serviceId: 'claudeCode',
                description: 'Anthropic models via API'
            } as any);

            // Mock probe results
            mockRunner.run.mockImplementation((command: string, args: string[]) => {
                const modelId = args[args.indexOf('--model') + 1];
                if (modelId === 'sonnet') {
                    // Simulate Sonnet failure
                    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'API error' });
                }
                // Simulate Haiku and Opus success
                return Promise.resolve({ exitCode: 0, stdout: 'YES', stderr: '' });
            });

            // Mock no existing outage
            mockClient.findExistingOutage.mockResolvedValue(undefined);

            await reporter.reportOutage();

            // Verify probing logic
            expect(mockRunner.run).toHaveBeenCalledTimes(3);
            expect(mockRunner.run).toHaveBeenCalledWith('claude', expect.arrayContaining(['--model', 'haiku']), expect.anything());

            // Verify URL generation
            expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
            const calledUrl: string = (vscode.env.openExternal as any).mock.calls[0][0];

            // Should be a new issue URL
            expect(calledUrl).toContain('https://github.com/binhonglee/mana-bar-status/issues/new');

            const decodedUrl = decodeURIComponent(calledUrl.replace(/\+/g, '%20'));

            // Check title is URL encoded properly
            expect(decodedUrl).toContain('template=outage-report.yml');

            // Sonnet failed, so title should contain full model ID, not just label
            expect(decodedUrl).toContain('title=[Outage] Claude Code - claude-sonnet-4-6');
            // Ensure we're NOT using just the short label
            expect(decodedUrl).not.toMatch(/title=\[Outage\] Claude Code - Sonnet[^-]/);

            // Check body contains the diagnostic text
            expect(decodedUrl).toContain('Haiku');
            expect(decodedUrl).toContain('Sonnet');
            expect(decodedUrl).toContain('Opus');
            expect(decodedUrl).toContain('API error');
        });

        it('should load Codex models from cache and construct service-wide issue URL if all fail', async () => {
            // Select Codex
            vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
                label: 'Codex',
                serviceId: 'codex',
                description: 'OpenAI models via API'
            } as any);

            // Mock Codex cache read
            const mockCodexModels = {
                models: [
                    { slug: 'gpt-4o', display_name: 'GPT-4o', visibility: 'list', shell_type: 'shell_command' },
                    { slug: 'gpt-4-turbo', display_name: 'GPT-4 Turbo', visibility: 'list', shell_type: 'shell_command' }
                ]
            };
            vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
                if (filePath.toString().includes('models_cache.json')) {
                    return JSON.stringify(mockCodexModels);
                }
                throw new Error('ENOENT');
            });

            // Mock ALL models failing
            mockRunner.run.mockRejectedValue(new Error('Connection refused'));

            // Mock existing service-wide outage
            const existingOutage = {
                issueNumber: 42,
                issueUrl: 'https://github.com/binhonglee/mana-bar-status/issues/42',
                service: 'Codex',
                model: undefined // Service-wide
            };
            mockClient.findExistingOutage.mockResolvedValue(existingOutage);

            await reporter.reportOutage();

            // Verify fallback to existing issue
            expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
            expect(vscode.env.openExternal).toHaveBeenCalledWith('https://github.com/binhonglee/mana-bar-status/issues/42');
        });
        
        it('should report failure if Codex models cannot be found in cache or config', async () => {
            vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
                label: 'Codex',
                serviceId: 'codex'
            } as any);

            // Mock ENOENT for both cache and config
            const error = new Error('File not found');
            (error as any).code = 'ENOENT';
            vi.mocked(fs.readFile).mockRejectedValue(error);

            // Mock no existing outage
            mockClient.findExistingOutage.mockResolvedValue(undefined);

            await reporter.reportOutage();

            // Should not run any probes
            expect(mockRunner.run).toHaveBeenCalledTimes(0);
            
            // Should open issue with the "No Codex models found" error message
            expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
            const calledUrl: string = (vscode.env.openExternal as any).mock.calls[0][0];
            const decodedUrl = decodeURIComponent(calledUrl.replace(/\+/g, '%20'));
            expect(decodedUrl).toContain('No Codex models found');
        });
    });
});
