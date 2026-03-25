import * as https from 'https';
import { OutageReport, OutageStatus, getStatusRepoOwner, getStatusRepoName, parseOutageTitle } from './outage-types';
import { debugLog } from '../logger';

interface GitHubIssue {
	number: number;
	title: string;
	html_url: string;
	created_at: string;
	labels: Array<{ name: string }>;
	reactions?: { '+1'?: number };
}

/**
 * Client for fetching outage status from the GitHub Issues API.
 * Reads from a public repo — no authentication needed.
 */
export class OutageClient {
	private cache: OutageStatus | null = null;
	private readonly cacheTtlMs: number;
	private fetchPromise: Promise<OutageStatus> | null = null;

	constructor(cacheTtlMs = 5 * 60 * 1000) {
		this.cacheTtlMs = cacheTtlMs;
	}

	/**
	 * Get the currently cached outage status without triggering a fetch
	 */
	getCachedData(): OutageStatus | null {
		return this.cache;
	}

	/**
	 * Get current outage reports, using cache if fresh
	 */
	async getOutageStatus(): Promise<OutageStatus> {
		if (this.cache && Date.now() - this.cache.lastFetched.getTime() < this.cacheTtlMs) {
			return this.cache;
		}

		// Deduplicate concurrent fetches
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = this.fetchOutages();
		try {
			const result = await this.fetchPromise;
			this.cache = result;
			return result;
		} finally {
			this.fetchPromise = null;
		}
	}

	/**
	 * Force refresh, ignoring cache
	 */
	async refresh(): Promise<OutageStatus> {
		this.cache = null;
		return this.getOutageStatus();
	}

	/**
	 * Get outage reports for a specific service
	 */
	async getOutagesForService(serviceName: string): Promise<OutageReport[]> {
		const status = await this.getOutageStatus();
		return status.reports.filter(
			(r) => r.service.toLowerCase() === serviceName.toLowerCase()
		);
	}

	/**
	 * Check if a matching outage issue already exists
	 */
	async findExistingOutage(service: string, model?: string): Promise<OutageReport | undefined> {
		const status = await this.getOutageStatus();
		return status.reports.find((r) => {
			const serviceMatch = r.service.toLowerCase() === service.toLowerCase();
			if (!model) {
				return serviceMatch && !r.model;
			}
			return serviceMatch && r.model?.toLowerCase() === model.toLowerCase();
		});
	}

	private async fetchOutages(): Promise<OutageStatus> {
		try {
			const owner = getStatusRepoOwner();
			const repo = getStatusRepoName();
			const apiPath = `/repos/${owner}/${repo}/issues?labels=outage&state=open&per_page=50`;

			debugLog(`[OutageClient] Fetching outages from GitHub: ${apiPath}`);
			const issues = await this.githubGet<GitHubIssue[]>(apiPath);

			const reports: OutageReport[] = [];
			for (const issue of issues) {
				const parsed = parseOutageTitle(issue.title);
				if (!parsed) {
					continue;
				}

				reports.push({
					issueNumber: issue.number,
					issueUrl: issue.html_url,
					title: issue.title,
					service: parsed.service,
					model: parsed.model,
					reactionCount: issue.reactions?.['+1'] ?? 0,
					verified: issue.labels.some((l) => l.name === 'verified'),
					createdAt: new Date(issue.created_at),
					labels: issue.labels.map((l) => l.name),
				});
			}

			debugLog(`[OutageClient] Found ${reports.length} outage report(s)`);
			return { reports, lastFetched: new Date() };
		} catch (error) {
			debugLog(`[OutageClient] Failed to fetch outages:`, error);
			// Return empty on error rather than throwing — outage status is non-critical
			return { reports: [], lastFetched: new Date() };
		}
	}

	private githubGet<T>(apiPath: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const options: https.RequestOptions = {
				hostname: 'api.github.com',
				path: apiPath,
				method: 'GET',
				headers: {
					'User-Agent': 'mana-bar-vscode',
					'Accept': 'application/vnd.github.v3+json',
				},
			};

			const req = https.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => { data += chunk; });
				res.on('end', () => {
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						try {
							resolve(JSON.parse(data) as T);
						} catch (e) {
							reject(new Error(`Failed to parse GitHub response: ${e}`));
						}
					} else {
						reject(new Error(`GitHub API returned ${res.statusCode}: ${data.slice(0, 200)}`));
					}
				});
			});

			req.on('error', reject);
			req.end();
		});
	}
}
