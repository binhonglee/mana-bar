import { ModelUsage, UsageData } from '../types';

export interface AuthorizedModelSortGroup {
	modelIds?: string[];
}

export interface AuthorizedModelSort {
	groups?: AuthorizedModelSortGroup[];
}

export interface ModelInfo {
	displayName?: string;
	model?: string;
	disabled?: boolean;
	quotaInfo?: {
		remainingFraction?: number;
		resetTime?: string;
	};
	tagTitle?: string;
	isInternal?: boolean;
}

export interface AuthorizedQuotaResponse {
	models?: Record<string, ModelInfo>;
	agentModelSorts?: AuthorizedModelSort[];
}

export function getAntigravityAllowedModelIds(response: AuthorizedQuotaResponse): Set<string> {
	const allowedModelIds = new Set<string>();

	for (const sort of response.agentModelSorts || []) {
		for (const group of sort.groups || []) {
			for (const id of group.modelIds || []) {
				allowedModelIds.add(id.toLowerCase());
			}
		}
	}

	return allowedModelIds;
}

export function normalizeAntigravityGroupMatchText(value: string | undefined): string {
	return (value || '')
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function resolveAntigravityAutoGroupFamily(modelId: string, label?: string): string {
	const modelIdLower = (modelId || '').toLowerCase();
	const labelText = normalizeAntigravityGroupMatchText(label || modelId || '');

	if (
		/^gemini-\d+(?:\.\d+)?-pro-image(?:-|$)/.test(modelIdLower)
		|| /^gemini \d+(?:\.\d+)? pro image\b/.test(labelText)
		|| modelIdLower === 'model_placeholder_m9'
	) {
		return 'gemini_image';
	}

	if (
		/^gemini-\d+(?:\.\d+)?-pro-(high|low)(?:-|$)/.test(modelIdLower)
		|| /^gemini \d+(?:\.\d+)? pro(?: \((high|low)\)| (high|low))\b/.test(labelText)
		|| modelIdLower === 'model_placeholder_m7'
		|| modelIdLower === 'model_placeholder_m8'
		|| modelIdLower === 'model_placeholder_m36'
		|| modelIdLower === 'model_placeholder_m37'
	) {
		return 'gemini_pro';
	}

	if (
		/^gemini-\d+(?:\.\d+)?-flash(?:-|$)/.test(modelIdLower)
		|| /^gemini \d+(?:\.\d+)? flash\b/.test(labelText)
		|| modelIdLower === 'model_placeholder_m18'
	) {
		return 'gemini_flash';
	}

	if (
		modelIdLower.startsWith('claude-')
		|| modelIdLower.startsWith('model_claude')
		|| labelText.startsWith('claude ')
		|| modelIdLower === 'model_placeholder_m12'
		|| modelIdLower === 'model_placeholder_m26'
		|| modelIdLower === 'model_placeholder_m35'
		|| modelIdLower === 'model_openai_gpt_oss_120b_medium'
	) {
		return 'claude';
	}

	return 'default';
}

export function getAntigravityGroupName(family: string): string {
	switch (family) {
		case 'gemini_image': return 'Gemini Image';
		case 'gemini_pro': return 'Gemini Pro';
		case 'gemini_flash': return 'Gemini Flash';
		case 'claude': return 'Claude';
		default: return 'Default';
	}
}

function shouldIncludeAntigravityModel(
	modelId: string,
	modelInfo: ModelInfo,
	allowedModelIds: Set<string>,
	requireQuota: boolean
): boolean {
	if (modelInfo.disabled || modelInfo.isInternal) {
		return false;
	}

	if (requireQuota && !modelInfo.quotaInfo) {
		return false;
	}

	if (!modelInfo.displayName || modelId.startsWith('tab_') || modelId.startsWith('chat_')) {
		return false;
	}

	if (allowedModelIds.size > 2 && !allowedModelIds.has(modelId.toLowerCase())) {
		return false;
	}

	return true;
}

export function groupAntigravityModelsByQuota(response: AuthorizedQuotaResponse): Map<string, ModelInfo[]> {
	const groups = new Map<string, ModelInfo[]>();
	const allowedModelIds = getAntigravityAllowedModelIds(response);

	for (const [modelId, modelInfo] of Object.entries(response.models || {})) {
		if (!shouldIncludeAntigravityModel(modelId, modelInfo, allowedModelIds, true)) {
			continue;
		}

		const family = resolveAntigravityAutoGroupFamily(modelInfo.model || modelId, modelInfo.displayName);
		const groupName = getAntigravityGroupName(family);

		if (!groups.has(groupName)) {
			groups.set(groupName, []);
		}
		groups.get(groupName)!.push(modelInfo);
	}

	return groups;
}

export function filterAntigravityModelsInGroup(
	response: AuthorizedQuotaResponse,
	groupName: string
): ModelInfo[] {
	const filtered: ModelInfo[] = [];
	const allowedModelIds = getAntigravityAllowedModelIds(response);

	for (const [modelId, modelInfo] of Object.entries(response.models || {})) {
		if (!shouldIncludeAntigravityModel(modelId, modelInfo, allowedModelIds, false)) {
			continue;
		}

		const family = resolveAntigravityAutoGroupFamily(modelInfo.model || modelId, modelInfo.displayName);
		const group = getAntigravityGroupName(family);

		if (group === groupName && modelInfo.quotaInfo && !modelInfo.disabled) {
			filtered.push(modelInfo);
		}
	}

	return filtered;
}

export function parseAntigravityQuotaForGroup(
	serviceName: string,
	groupModels: ModelInfo[],
	lastUpdated = new Date()
): UsageData {
	let maxUsedPercent = 0;
	let earliestReset: Date | null = null;
	const models: ModelUsage[] = [];

	for (const modelInfo of groupModels) {
		if (!modelInfo.quotaInfo) {
			continue;
		}

		const remaining = modelInfo.quotaInfo.remainingFraction || 0;
		const used = (1 - remaining) * 100;
		const resetTime = new Date(modelInfo.quotaInfo.resetTime || 0);

		if (used > maxUsedPercent) {
			maxUsedPercent = used;
		}

		if (!earliestReset || resetTime < earliestReset) {
			earliestReset = resetTime;
		}

		models.push({
			modelName: modelInfo.displayName || modelInfo.model || 'Unknown',
			used: Math.round(used),
			limit: 100,
			resetTime,
		});
	}

	return {
		serviceId: 'antigravity',
		serviceName,
		totalUsed: Math.round(maxUsedPercent),
		totalLimit: 100,
		resetTime: earliestReset || lastUpdated,
		progressSegments: 5,
		models,
		lastUpdated,
	};
}
