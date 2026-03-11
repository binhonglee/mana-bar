import { UsageProvider } from './base';
import { UsageData } from '../types';
import { spawn, ChildProcess } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { CodexRateLimitsResponse, parseCodexRateLimitsResponse } from './codex-parse';

const execAsync = promisify(exec);

/**
 * Provider for Codex usage tracking
 *
 * Uses Codex app-server JSON-RPC endpoint to fetch quota information.
 * This endpoint is read-only and does NOT count against user quota.
 *
 * Implementation approach:
 * - Spawns `codex app-server --listen stdio://` as a subprocess
 * - Communicates via stdin/stdout using newline-delimited JSON (JSONL)
 * - Maintains a long-lived process for efficiency
 * - Stores PID in globalState to clean up orphaned processes on next session
 * - Proper cleanup in dispose() to prevent process leaks
 */
export class CodexProvider extends UsageProvider {
	private readonly CACHE_TTL = 180 * 1000; // 3 minutes
	private readonly PID_STORAGE_KEY = 'codexAppServerPid';

	private appServerProcess: ChildProcess | null = null;
	private cachedData: UsageData | null = null;
	private cacheExpiry: number = 0;
	private context: vscode.ExtensionContext;
	private nextRequestId = 1;
	private isInitialized = false;

	constructor(context: vscode.ExtensionContext) {
		super();
		this.context = context;
		this.cleanupOrphanedProcess();
	}

	getServiceName(): string {
		return 'Codex';
	}

	async isAvailable(): Promise<boolean> {
		try {
			// Check if codex CLI is installed
			await execAsync('which codex');
			return true;
		} catch {
			return false;
		}
	}

	async getUsage(): Promise<UsageData | null> {
		// Return cached data if still valid
		if (this.cachedData && Date.now() < this.cacheExpiry) {
			return this.cachedData;
		}

		try {
			// Ensure app-server is running
			if (!this.appServerProcess) {
				await this.spawnAppServer();
			}

			// Initialize connection if needed
			if (!this.isInitialized) {
				await this.initializeConnection();
			}

			const usageData = await this.fetchRateLimits();
			if (usageData) {
				this.cachedData = usageData;
				this.cacheExpiry = Date.now() + this.CACHE_TTL;
			}

			return usageData;
		} catch (error) {
			console.error('Failed to fetch Codex usage:', error);
			return this.cachedData; // Return stale cache on error
		}
	}

	async getModels(): Promise<string[]> {
		// Codex doesn't provide per-model breakdown in rate limits API
		return [];
	}

	/**
	 * Clean up any orphaned process from previous session
	 */
	private async cleanupOrphanedProcess() {
		const storedPid = this.context.globalState.get<number>(this.PID_STORAGE_KEY);
		if (!storedPid) return;

		try {
			// Check if process exists and is codex app-server
			const { stdout } = await execAsync(`ps -p ${storedPid} -o command=`);
			if (stdout.includes('codex') && stdout.includes('app-server')) {
				console.log(`[Codex] Cleaning up orphaned codex app-server (PID ${storedPid})`);
				process.kill(storedPid, 'SIGTERM');
			}
		} catch {
			// Process doesn't exist, that's fine
		} finally {
			await this.context.globalState.update(this.PID_STORAGE_KEY, undefined);
		}
	}

	/**
	 * Spawn the codex app-server subprocess
	 */
	private async spawnAppServer(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.appServerProcess = spawn('codex', ['app-server'], {
				stdio: ['pipe', 'pipe', 'pipe']
			});

			if (!this.appServerProcess.pid) {
				reject(new Error('Failed to spawn codex app-server'));
				return;
			}

			// Store PID for cleanup on next session
			this.context.globalState.update(this.PID_STORAGE_KEY, this.appServerProcess.pid);

			// Clear PID when process exits naturally
			this.appServerProcess.on('exit', (code) => {
				console.log(`[Codex] app-server exited with code ${code}`);
				this.context.globalState.update(this.PID_STORAGE_KEY, undefined);
				this.appServerProcess = null;
				this.isInitialized = false;
			});

			// Handle stderr for debugging
			this.appServerProcess.stderr?.on('data', (data) => {
				console.error(`[Codex] app-server stderr: ${data}`);
			});

			// Give it a moment to start
			setTimeout(() => resolve(), 100);
		});
	}

	/**
	 * Initialize the JSON-RPC connection with handshake
	 */
	private async initializeConnection(): Promise<void> {
		// Send initialize request
		await this.sendRequest({
			method: 'initialize',
			id: this.nextRequestId++,
			params: {
				clientInfo: {
					name: 'llm-usage-tracker',
					title: 'LLM Usage Tracker',
					version: '0.1.0'
				}
			}
		});

		// Send initialized notification
		await this.sendNotification({
			method: 'initialized'
		});

		this.isInitialized = true;
	}

	/**
	 * Fetch rate limits from the app-server
	 */
	private async fetchRateLimits(): Promise<UsageData | null> {
		const response = await this.sendRequest<CodexRateLimitsResponse>({
			method: 'account/rateLimits/read',
			id: this.nextRequestId++
		});

		if (!response?.result?.rateLimits) {
			return null;
		}

		return this.parseRateLimitsResponse(response);
	}

	/**
	 * Send a JSON-RPC request and wait for response
	 */
	private async sendRequest<T = any>(request: any): Promise<T | null> {
		return new Promise((resolve, reject) => {
			if (!this.appServerProcess?.stdout || !this.appServerProcess?.stdin) {
				reject(new Error('App server not running'));
				return;
			}

			const requestJson = JSON.stringify(request) + '\n';

			// Listen for response
			const onData = (data: Buffer) => {
				const lines = data.toString().split('\n').filter(line => line.trim());
				for (const line of lines) {
					try {
						const response = JSON.parse(line);
						if (response.id === request.id) {
							this.appServerProcess?.stdout?.off('data', onData);
							resolve(response);
							return;
						}
					} catch (error) {
						// Ignore parse errors for partial data
					}
				}
			};

			this.appServerProcess.stdout.on('data', onData);

			// Set timeout
			const timeout = setTimeout(() => {
				this.appServerProcess?.stdout?.off('data', onData);
				reject(new Error('Request timeout'));
			}, 5000);

			// Send request
			this.appServerProcess.stdin.write(requestJson, (error) => {
				if (error) {
					clearTimeout(timeout);
					this.appServerProcess?.stdout?.off('data', onData);
					reject(error);
				}
			});
		});
	}

	/**
	 * Send a JSON-RPC notification (no response expected)
	 */
	private async sendNotification(notification: any): Promise<void> {
		if (!this.appServerProcess?.stdin) {
			throw new Error('App server not running');
		}

		const notificationJson = JSON.stringify(notification) + '\n';
		return new Promise((resolve, reject) => {
			this.appServerProcess!.stdin!.write(notificationJson, (error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Parse rate limits response into our UsageData format
	 */
	private parseRateLimitsResponse(response: CodexRateLimitsResponse): UsageData {
		return parseCodexRateLimitsResponse(response, this.getServiceName(), new Date());
	}

	/**
	 * Clean up the subprocess
	 */
	dispose() {
		if (this.appServerProcess) {
			console.log(`[Codex] Disposing app-server (PID ${this.appServerProcess.pid})`);
			this.appServerProcess.kill('SIGTERM');
			this.context.globalState.update(this.PID_STORAGE_KEY, undefined);
			this.appServerProcess = null;
			this.isInitialized = false;
		}
	}
}
