export interface GeminiQuotaBucket {
	remainingAmount?: string;
	remainingFraction?: number;
	resetTime?: string;
	tokenType?: string;
	modelId?: string;
}

export interface GeminiModelsModule {
	VALID_GEMINI_MODELS?: unknown;
}

export interface GeminiDefaultModelConfig {
	modelConfig?: {
		model?: string;
	};
}

export interface GeminiDefaultModelConfigsModule {
	DEFAULT_MODEL_CONFIGS?: {
		aliases?: Record<string, GeminiDefaultModelConfig>;
	};
}

export function uniqueGeminiModelIds(modelIds: string[]): string[] {
	const ordered = new Set<string>();
	for (const modelId of modelIds) {
		if (!modelId || !modelId.startsWith('gemini-')) {
			continue;
		}
		ordered.add(modelId);
	}
	return [...ordered];
}

export function extractValidGeminiModels(module: GeminiModelsModule): string[] {
	const visibleModels = module.VALID_GEMINI_MODELS;
	if (!(visibleModels instanceof Set)) {
		return [];
	}

	return uniqueGeminiModelIds([...visibleModels]);
}

export function extractGeminiModelsFromDefaultConfigs(module: GeminiDefaultModelConfigsModule): string[] {
	const aliases = module.DEFAULT_MODEL_CONFIGS?.aliases;
	if (!aliases) {
		return [];
	}

	return uniqueGeminiModelIds(
		Object.entries(aliases)
			.filter(([alias, config]) => alias.startsWith('gemini-') && config.modelConfig?.model === alias)
			.map(([alias]) => alias)
	);
}

export function normalizeGeminiQuotaBuckets(
	buckets: GeminiQuotaBucket[],
	allowedModelIds: Set<string> | null
): GeminiQuotaBucket[] {
	const orderedModelIds: string[] = [];
	const selectedBuckets = new Map<string, GeminiQuotaBucket>();

	for (const bucket of buckets) {
		const modelId = bucket.modelId;
		if (!modelId) {
			continue;
		}

		if (allowedModelIds && !allowedModelIds.has(modelId)) {
			continue;
		}

		if (!selectedBuckets.has(modelId)) {
			selectedBuckets.set(modelId, bucket);
			orderedModelIds.push(modelId);
			continue;
		}

		const existing = selectedBuckets.get(modelId)!;
		if (existing.tokenType === 'REQUESTS') {
			continue;
		}
		if (bucket.tokenType === 'REQUESTS') {
			selectedBuckets.set(modelId, bucket);
		}
	}

	return orderedModelIds
		.map(modelId => selectedBuckets.get(modelId))
		.filter((bucket): bucket is GeminiQuotaBucket => Boolean(bucket));
}

export function humanizeGeminiModelLabel(modelId: string): string {
	const suffix = modelId.replace(/^gemini-/, '');
	const tokens = suffix.split(/[-_]+/).filter(Boolean);

	return tokens.map(token => {
		if (/^\d+(?:\.\d+)?$/.test(token)) {
			return token;
		}

		switch (token.toLowerCase()) {
			case 'pro': return 'Pro';
			case 'flash': return 'Flash';
			case 'lite': return 'Lite';
			case 'preview': return 'Preview';
			case 'vertex': return 'Vertex';
			case 'customtools': return 'Custom Tools';
			default: return token.charAt(0).toUpperCase() + token.slice(1);
		}
	}).join(' ');
}
