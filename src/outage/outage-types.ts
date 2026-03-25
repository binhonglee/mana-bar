import { ServiceId } from '../types';

/**
 * Represents a single outage report from the status repo
 */
export interface OutageReport {
	issueNumber: number;
	issueUrl: string;
	title: string;
	service: string;
	model?: string;
	reactionCount: number;
	verified: boolean;
	createdAt: Date;
	labels: string[];
}

/**
 * Cached outage status
 */
export interface OutageStatus {
	reports: OutageReport[];
	lastFetched: Date;
}

/**
 * Result of probing a single model
 */
export interface ModelProbeResult {
	modelId: string;
	modelLabel: string;
	apiModelId?: string;
	success: boolean;
	error?: string;
}

/**
 * Result of probing all models for a service
 */
export interface ServiceProbeResults {
	service: string;
	serviceId: ServiceId;
	results: ModelProbeResult[];
	timestamp: Date;
}

/**
 * Serialized outage report for webview communication
 */
export interface SerializedOutageReport {
	issueNumber: number;
	issueUrl: string;
	title: string;
	service: string;
	model?: string;
	reactionCount: number;
	verified: boolean;
	createdAt: string;
}

const STATUS_REPO_OWNER = 'binhonglee';
const STATUS_REPO_NAME = 'mana-bar-status';

export function getStatusRepoOwner(): string {
	return STATUS_REPO_OWNER;
}

export function getStatusRepoName(): string {
	return STATUS_REPO_NAME;
}

export function getStatusRepoUrl(): string {
	return `https://github.com/${STATUS_REPO_OWNER}/${STATUS_REPO_NAME}`;
}

/**
 * Parse an issue title like "[Outage] Claude Code - claude-sonnet-4-6" or "[Outage] Claude Code - Sonnet" into service and model
 */
export function parseOutageTitle(title: string): { service: string; model?: string } | null {
	const match = title.match(/^\[Outage\]\s+(.+?)(?:\s+-\s+(.+))?$/);
	if (!match) {
		return null;
	}
	return {
		service: match[1].trim(),
		model: match[2]?.trim(),
	};
}

/**
 * Build issue title from service and model
 */
export function buildOutageTitle(service: string, model?: string): string {
	return model ? `[Outage] ${service} - ${model}` : `[Outage] ${service}`;
}

/**
 * Build URL to create a new outage issue with pre-filled fields
 */
export function buildNewIssueUrl(service: string, model?: string, diagnosticResults?: string): string {
	const title = buildOutageTitle(service, model);
	const serviceLabel = service.toLowerCase().replace(/\s+/g, '-');

	const params = new URLSearchParams();
	params.set('template', 'outage-report.yml');
	params.set('title', title);
	params.set('labels', `outage,${serviceLabel}`);

	if (model) {
		params.set('affected-models', model);
	}
	if (diagnosticResults) {
		params.set('diagnostic-results', diagnosticResults);
	}

	return `${getStatusRepoUrl()}/issues/new?${params.toString()}`;
}

/**
 * Serialize OutageReport for webview communication
 */
export function serializeOutageReport(report: OutageReport): SerializedOutageReport {
	return {
		issueNumber: report.issueNumber,
		issueUrl: report.issueUrl,
		title: report.title,
		service: report.service,
		model: report.model,
		reactionCount: report.reactionCount,
		verified: report.verified,
		createdAt: report.createdAt.toISOString(),
	};
}
