import { describe, expect, it } from 'vitest';
import {
	extractGeminiModelsFromDefaultConfigs,
	extractValidGeminiModels,
	humanizeGeminiModelLabel,
	normalizeGeminiQuotaBuckets,
} from '../../src/providers/gemini-parse';

describe('gemini parse helpers', () => {
	it('extracts VALID_GEMINI_MODELS entries and ignores invalid ones', () => {
		const modelIds = extractValidGeminiModels({
			VALID_GEMINI_MODELS: new Set([
				'gemini-2.5-pro',
				'gemini-3-flash-preview',
				'not-gemini',
				'gemini-2.5-pro',
			]),
		});

		expect(modelIds).toEqual(['gemini-2.5-pro', 'gemini-3-flash-preview']);
	});

	it('extracts canonical gemini aliases from default model configs', () => {
		const modelIds = extractGeminiModelsFromDefaultConfigs({
			DEFAULT_MODEL_CONFIGS: {
				aliases: {
					'gemini-2.5-pro': { modelConfig: { model: 'gemini-2.5-pro' } },
					'gemini-2.5-flash': { modelConfig: { model: 'gemini-2.5-flash' } },
					'classifier': { modelConfig: { model: 'classifier' } },
					'gemini-3-base': { modelConfig: { model: 'something-else' } },
				},
			},
		});

		expect(modelIds).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
	});

	it('dedupes quota buckets and prefers REQUESTS buckets within the allowlist', () => {
		const buckets = normalizeGeminiQuotaBuckets([
			{ modelId: 'gemini-2.5-pro', tokenType: 'TOKENS', remainingFraction: 0.8 },
			{ modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.7 },
			{ modelId: 'gemini-3-flash-preview', tokenType: 'REQUESTS', remainingFraction: 0.5 },
			{ modelId: 'gemini-2.0-flash', tokenType: 'REQUESTS', remainingFraction: 0.9 },
		], new Set(['gemini-2.5-pro', 'gemini-3-flash-preview']));

		expect(buckets).toEqual([
			{ modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.7 },
			{ modelId: 'gemini-3-flash-preview', tokenType: 'REQUESTS', remainingFraction: 0.5 },
		]);
		expect(humanizeGeminiModelLabel('gemini-3-flash-preview')).toBe('3 Flash Preview');
	});
});
