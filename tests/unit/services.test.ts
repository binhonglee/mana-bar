import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
	getDefaultServicesConfig,
	getServiceDescriptors,
	getShortServiceLabel,
} from '../../src/services';
import { SERVICE_IDS } from '../../src/types';

describe('service registry', () => {
	it('defines descriptors for every supported service', () => {
		const service_descriptors = getServiceDescriptors().map((descriptor) => (descriptor.id));
		service_descriptors.map((descriptor) => expect(SERVICE_IDS).toContain(descriptor));
		SERVICE_IDS.map((SERVICE_ID) => expect(service_descriptors).toContain(SERVICE_ID));
		expect(getDefaultServicesConfig()).toEqual({
			claudeCode: { enabled: true },
			codex: { enabled: true },
			vscodeCopilot: { enabled: true },
			copilotCli: { enabled: true },
			cursor: { enabled: true },
			antigravity: { enabled: true },
			gemini: { enabled: true },
			kiro: { enabled: true },
		});
	});

	it('keeps runtime service defaults aligned with package.json contribution defaults', () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
		) as {
			contributes?: {
				configuration?: {
					properties?: {
						'manaBar.services'?: {
							default?: unknown;
						};
					};
				};
			};
		};

		expect(packageJson.contributes?.configuration?.properties?.['manaBar.services']?.default).toEqual(
			getDefaultServicesConfig()
		);
	});

	it('builds compact labels for grouped services', () => {
		expect(getShortServiceLabel('claudeCode', 'Claude Code')).toBe('Claude');
		expect(getShortServiceLabel('antigravity', 'Antigravity Gemini Flash')).toBe('AG Flash');
		expect(getShortServiceLabel('gemini', 'Gemini CLI 2.5 Flash Preview Vertex')).toBe('GCLI 2.5 Flash');
	});
});
