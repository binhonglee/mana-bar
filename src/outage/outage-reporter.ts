import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OutageClient } from './outage-client';
import {
	ModelProbeResult,
	ServiceProbeResults,
	buildNewIssueUrl,
} from './outage-types';
import { SERVICE_DESCRIPTORS } from '../services';
import { ServiceId } from '../types';
import { debugLog } from '../logger';

interface CommandRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface CommandRunner {
	run(command: string, args: string[], options: { cwd: string; input?: string }): Promise<CommandRunResult>;
}

class SpawnCommandRunner implements CommandRunner {
	run(command: string, args: string[], options: { cwd: string; input?: string }): Promise<CommandRunResult> {
		return new Promise((resolve, reject) => {
			let stdout = '';
			let stderr = '';

			const child = spawn(command, args, {
				cwd: options.cwd,
				env: process.env,
				stdio: 'pipe',
			});

			// Timeout after 30 seconds
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error('Probe timed out after 30s'));
			}, 30_000);

			child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
			child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

			child.on('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});

			child.on('close', (exitCode) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, exitCode });
			});

			if (options.input) {
				child.stdin?.write(options.input);
			}
			child.stdin?.end();
		});
	}
}

const CLAUDE_MODELS: Array<{ id: string; label: string; apiModelId: string }> = [
	{ id: 'haiku', label: 'Haiku', apiModelId: 'claude-haiku-4-5' },
	{ id: 'sonnet', label: 'Sonnet', apiModelId: 'claude-sonnet-4-6' },
	{ id: 'opus', label: 'Opus', apiModelId: 'claude-opus-4-6' },
];

interface CodexModelOption {
	id: string;
	label: string;
}

/**
 * Parse Codex JSONL output to check if the model responded
 */
function parseCodexJsonlSuccess(stdout: string): boolean {
	for (const line of stdout.trim().split('\n')) {
		try {
			const event = JSON.parse(line) as {
				type?: string;
				item?: { type?: string; text?: string };
			};
			if (
				event.type === 'item.completed' &&
				event.item?.type === 'agent_message' &&
				typeof event.item.text === 'string'
			) {
				return true;
			}
		} catch {
			// Skip non-JSON lines
		}
	}
	return false;
}

// Services we support for outage reporting
const REPORTABLE_SERVICES: ServiceId[] = ['claudeCode', 'codex', 'copilotCli'];

// Default models for Copilot CLI probing (can be overridden in settings)
const DEFAULT_COPILOT_CLI_MODELS: Array<{ id: string; label: string }> = [
	{ id: 'claude-sonnet-4.6', label: 'Claude Sonnet' },
	{ id: 'gpt-5.2', label: 'GPT-5.2' },
];

export class OutageReporter {
	private readonly commandRunner: CommandRunner;
	private readonly userHomeDir: string;

	constructor(
		private readonly outageClient: OutageClient,
		options?: { commandRunner?: CommandRunner; userHomeDir?: string }
	) {
		this.commandRunner = options?.commandRunner ?? new SpawnCommandRunner();
		this.userHomeDir = options?.userHomeDir ?? os.homedir();
	}

	/**
	 * Main entry point: show service picker, run diagnostics, open issue
	 */
	async reportOutage(preselectedServiceId?: ServiceId): Promise<void> {
		// Pick service
		const serviceId = preselectedServiceId ?? await this.pickService();
		if (!serviceId) {
			return;
		}

		const serviceName = SERVICE_DESCRIPTORS[serviceId].name;

		// Run diagnostics with progress
		const probeResults = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Probing ${serviceName} models...`,
				cancellable: true,
			},
			async (_progress, token) => {
				const results = await this.probeService(serviceId);
				if (token.isCancellationRequested) {
					return null;
				}
				return results;
			}
		);

		if (!probeResults) {
			return;
		}

		// Show results and open issue
		await this.showResultsAndReport(probeResults);
	}

	private async pickService(): Promise<ServiceId | undefined> {
		const items = REPORTABLE_SERVICES.map((id) => ({
			label: SERVICE_DESCRIPTORS[id].name,
			description: SERVICE_DESCRIPTORS[id].description,
			serviceId: id,
		}));

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Which service is experiencing issues?',
			title: 'Report Outage',
		});

		return picked?.serviceId;
	}

	private async probeService(serviceId: ServiceId): Promise<ServiceProbeResults> {
		const serviceName = SERVICE_DESCRIPTORS[serviceId].name;
		let modelResults: ModelProbeResult[];

		switch (serviceId) {
			case 'claudeCode':
				modelResults = await this.probeClaudeModels();
				break;
			case 'codex':
				modelResults = await this.probeCodexModels();
				break;
			case 'copilotCli':
				modelResults = await this.probeCopilotCliModels();
				break;
			default:
				modelResults = [];
		}

		return {
			service: serviceName,
			serviceId,
			results: modelResults,
			timestamp: new Date(),
		};
	}

	private async probeClaudeModels(): Promise<ModelProbeResult[]> {
		const results: ModelProbeResult[] = [];

		for (const model of CLAUDE_MODELS) {
			debugLog(`[OutageReporter] Probing Claude ${model.label}...`);
			try {
				const result = await this.commandRunner.run(
					'claude',
					['-p', '--output-format', 'text', '--model', model.id, '--permission-mode', 'dontAsk', '--tools', ''],
					{ cwd: this.userHomeDir, input: 'Reply YES' }
				);
				const success = result.exitCode === 0 && result.stdout.trim().length > 0;
				results.push({
					modelId: model.id,
					modelLabel: model.label,
					apiModelId: model.apiModelId,
					success,
					error: success ? undefined : (result.stderr.trim() || 'No response'),
				});
			} catch (error) {
				results.push({
					modelId: model.id,
					modelLabel: model.label,
					apiModelId: model.apiModelId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return results;
	}

	private async probeCodexModels(): Promise<ModelProbeResult[]> {
		const models = await this.getCodexModels();
		if (models.length === 0) {
			return [{
				modelId: 'default',
				modelLabel: 'Default',
				success: false,
				error: 'No Codex models found',
			}];
		}

		const results: ModelProbeResult[] = [];
		for (const model of models) {
			debugLog(`[OutageReporter] Probing Codex ${model.label}...`);
			try {
				const result = await this.commandRunner.run(
					'codex',
					['exec', '--color', 'never', '--json', '--skip-git-repo-check', '--model', model.id, '-'],
					{ cwd: this.userHomeDir, input: 'Reply YES' }
				);
				const success = result.exitCode === 0 && parseCodexJsonlSuccess(result.stdout);
				results.push({
					modelId: model.id,
					modelLabel: model.label,
					success,
					error: success ? undefined : (result.stderr.trim() || 'No response'),
				});
			} catch (error) {
				results.push({
					modelId: model.id,
					modelLabel: model.label,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return results;
	}

	private async getCodexModels(): Promise<CodexModelOption[]> {
		// Read from Codex models cache (same approach as git_isl)
		const cachePath = path.join(this.userHomeDir, '.codex', 'models_cache.json');
		try {
			const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
				models?: Array<{
					slug?: unknown;
					display_name?: unknown;
					visibility?: unknown;
					shell_type?: unknown;
				}>;
			};

			const options = (cache.models ?? [])
				.filter((m) =>
					typeof m.slug === 'string' &&
					typeof m.display_name === 'string' &&
					m.visibility === 'list' &&
					m.shell_type === 'shell_command'
				)
				.map((m) => ({
					id: m.slug as string,
					label: m.display_name as string,
				}));

			if (options.length > 0) {
				return options;
			}
		} catch {
			// Fall through to config
		}

		// Fall back to configured model from config.toml
		const configPath = path.join(this.userHomeDir, '.codex', 'config.toml');
		try {
			const config = await readFile(configPath, 'utf8');
			const match = config.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
			const modelId = match?.[1]?.trim();
			if (modelId) {
				return [{ id: modelId, label: modelId }];
			}
		} catch {
			// No config
		}

		return [];
	}

	private getCopilotCliModelsToProbe(): Array<{ id: string; label: string }> {
		// Read from VS Code settings, fall back to defaults
		const config = vscode.workspace.getConfiguration('manaBar');
		const customModels = config.get<string[]>('copilotCliModels');
		if (customModels?.length) {
			return customModels.map(id => ({ id, label: id }));
		}
		return DEFAULT_COPILOT_CLI_MODELS;
	}

	private async probeCopilotCliModels(): Promise<ModelProbeResult[]> {
		const models = this.getCopilotCliModelsToProbe();
		const results: ModelProbeResult[] = [];

		for (const model of models) {
			debugLog(`[OutageReporter] Probing Copilot CLI ${model.label}...`);
			try {
				const result = await this.commandRunner.run(
					'copilot',
					['-p', 'Reply YES', '--allow-all-tools', '--model', model.id],
					{ cwd: this.userHomeDir }
				);
				// Check for success - non-zero exit code or empty output indicates failure
				const success = result.exitCode === 0 && result.stdout.trim().length > 0;
				results.push({
					modelId: model.id,
					modelLabel: model.label,
					success,
					error: success ? undefined : (result.stderr.trim() || 'No response'),
				});
			} catch (error) {
				results.push({
					modelId: model.id,
					modelLabel: model.label,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return results;
	}

	private async showResultsAndReport(probeResults: ServiceProbeResults): Promise<void> {
		const { service, results } = probeResults;
		const downModels = results.filter((r) => !r.success);
		const upModels = results.filter((r) => r.success);

		if (downModels.length === 0) {
			vscode.window.showInformationMessage(
				`All ${service} models are responding. No outage detected.`
			);
			return;
		}

		// Build diagnostic summary
		const summaryParts = results.map((r) =>
			`${r.success ? '✅' : '❌'} ${r.modelLabel}`
		);
		const summary = summaryParts.join(' — ');
		const diagnosticText = results.map((r) =>
			`${r.success ? '✅' : '❌'} ${r.modelLabel}${r.error ? `: ${r.error}` : ''}`
		).join('\n');

		// Determine what to report
		if (downModels.length === 1) {
			// Single model down — report for that specific model
			await this.openIssueForModel(service, downModels[0], diagnosticText);
		} else if (upModels.length === 0) {
			// All models down — report service-wide
			await this.openIssueForService(service, diagnosticText);
		} else {
			// Multiple (but not all) models down — let user pick which to report
			const items = [
				{
					label: `Report all (${downModels.length} models down)`,
					description: summary,
					action: 'all' as const,
				},
				...downModels.map((m) => ({
					label: `Report ${m.modelLabel} only`,
					description: m.error || 'Not responding',
					action: 'single' as const,
					model: m,
				})),
			];

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: `${summary} — What would you like to report?`,
				title: 'Report Outage',
			});

			if (!picked) {
				return;
			}

			if (picked.action === 'all') {
				await this.openIssueForService(service, diagnosticText);
			} else if ('model' in picked) {
				await this.openIssueForModel(service, picked.model!, diagnosticText);
			}
		}
	}

	private async openIssueForModel(
		service: string,
		model: ModelProbeResult,
		diagnosticText: string
	): Promise<void> {
		// Use apiModelId for issue title/URL if available, fall back to label
		const modelIdentifier = model.apiModelId || model.modelLabel;

		// Check for existing service-wide issue first
		const existingServiceWide = await this.outageClient.findExistingOutage(service);
		if (existingServiceWide) {
			const action = await vscode.window.showInformationMessage(
				`A service-wide outage has already been reported for ${service}.`,
				'View active outage', 'File model-specific report anyway'
			);
			if (action === 'View active outage') {
				await vscode.env.openExternal(vscode.Uri.parse(existingServiceWide.issueUrl));
				return;
			} else if (!action) {
				return; // user cancelled
			}
		}

		// Check for existing issue (check both apiModelId and label for backwards compatibility)
		const existing = await this.outageClient.findExistingOutage(service, modelIdentifier)
			|| (model.apiModelId ? await this.outageClient.findExistingOutage(service, model.modelLabel) : null);
		if (existing) {
			await vscode.env.openExternal(vscode.Uri.parse(existing.issueUrl));
			vscode.window.showInformationMessage(
				`Opened existing outage report for ${service} - ${modelIdentifier}. Add a 👍 to confirm you're affected!`
			);
			return;
		}

		const url = buildNewIssueUrl(service, modelIdentifier, diagnosticText);
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	private async openIssueForService(
		service: string,
		diagnosticText: string
	): Promise<void> {
		// Check for existing service-wide issue
		const existing = await this.outageClient.findExistingOutage(service);
		if (existing) {
			await vscode.env.openExternal(vscode.Uri.parse(existing.issueUrl));
			vscode.window.showInformationMessage(
				`Opened existing outage report for ${service}. Add a 👍 to confirm you're affected!`
			);
			return;
		}

		const url = buildNewIssueUrl(service, undefined, diagnosticText);
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}
}
