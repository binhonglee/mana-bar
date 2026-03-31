import { ServiceId, ServicesConfig } from './types';

export interface ServiceDescriptor {
	id: ServiceId;
	name: string;
	description: string;
	defaultEnabled: boolean;
	getShortLabel: (serviceName: string) => string;
}

function abbreviateGeminiServiceName(serviceName: string): string {
	const compactLabel = serviceName
		.replace(/^Gemini CLI\s+/, '')
		.replace(/\bFlash Lite\b/gi, 'Lite')
		.replace(/\bPreview\b/gi, '')
		.replace(/\bVertex\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();

	return compactLabel ? `GCLI ${compactLabel}` : 'Gemini CLI';
}

export const SERVICE_DESCRIPTORS: Record<ServiceId, ServiceDescriptor> = {
	claudeCode: {
		id: 'claudeCode',
		name: 'Claude Code',
		description: 'Claude Code usage',
		defaultEnabled: true,
		getShortLabel: () => 'Claude',
	},
	codex: {
		id: 'codex',
		name: 'Codex',
		description: 'OpenAI Codex CLI usage',
		defaultEnabled: true,
		getShortLabel: () => 'Codex',
	},
	vscodeCopilot: {
		id: 'vscodeCopilot',
		name: 'VSCode Copilot',
		description: 'VSCode Copilot usage',
		defaultEnabled: true,
		getShortLabel: () => 'Copilot',
	},
	copilotCli: {
		id: 'copilotCli',
		name: 'Copilot CLI',
		description: 'GitHub Copilot CLI usage',
		defaultEnabled: true,
		getShortLabel: () => 'CopCLI',
	},
	cursor: {
		id: 'cursor',
		name: 'Cursor',
		description: 'Cursor usage',
		defaultEnabled: true,
		getShortLabel: () => 'Cursor',
	},
	antigravity: {
		id: 'antigravity',
		name: 'Antigravity',
		description: 'Google Antigravity usage',
		defaultEnabled: true,
		getShortLabel: (serviceName: string) => {
			return serviceName.replace('Antigravity ', 'AG ').replace('Gemini ', '');
		},
	},
	gemini: {
		id: 'gemini',
		name: 'Gemini CLI',
		description: 'Google Gemini CLI usage',
		defaultEnabled: true,
		getShortLabel: abbreviateGeminiServiceName,
	},
};

export function getServiceDescriptor(serviceId: ServiceId): ServiceDescriptor {
	return SERVICE_DESCRIPTORS[serviceId];
}

export function getServiceDescriptors(): ServiceDescriptor[] {
	return Object.values(SERVICE_DESCRIPTORS);
}

export function getDefaultServicesConfig(): ServicesConfig {
	return Object.fromEntries(
		getServiceDescriptors().map((descriptor) => [
			descriptor.id,
			{ enabled: descriptor.defaultEnabled },
		])
	) as ServicesConfig;
}

export function getShortServiceLabel(serviceId: ServiceId, serviceName: string): string {
	return getServiceDescriptor(serviceId).getShortLabel(serviceName);
}
