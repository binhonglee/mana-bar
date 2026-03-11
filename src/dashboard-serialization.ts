import { ConfigManager } from './managers/config-manager';
import { ServiceDescriptor, getServiceDescriptors } from './services';
import { ServiceId, ServicesConfig, StatusBarTooltipLayout, UsageData, UsageDisplayMode, UsageStatus } from './types';
import { toServiceViewModel, toUsageMetricViewModel } from './usage-display';

export interface DashboardServiceDescriptor {
	id: ServiceId;
	name: string;
	description: string;
}

export interface SerializedModelUsage {
	modelName: string;
	used: number;
	limit: number;
	resetTime?: string;
}

export interface SerializedUsageMetric {
	used: number;
	limit: number;
	displayText: string;
	displayValueText: string;
	displayUnit: string;
	displayPercent: number;
	displayVerb: string;
	status: UsageStatus;
	statusEmoji: string;
	resetTime?: string;
	resetText?: string;
}

export interface SerializedUsageData extends SerializedUsageMetric {
	serviceId: ServiceId;
	serviceName: string;
	totalUsed: number;
	totalLimit: number;
	shortLabel: string;
	summaryText: string;
	progressSegments?: number;
	quotaWindows?: Array<SerializedUsageMetric & { label: string }>;
	models?: SerializedModelUsage[];
	lastUpdated: string;
}

export interface DashboardConfigPayload {
	displayMode: UsageDisplayMode;
	statusBarTooltipLayout: StatusBarTooltipLayout;
	debugLogs: boolean;
	pollingInterval: number;
	services: ServicesConfig;
	hiddenServices: string[];
	serviceDescriptors: DashboardServiceDescriptor[];
}

export type HostToWebviewMessage =
	| { type: 'usageUpdate'; data: SerializedUsageData[]; timestamp: string }
	| { type: 'configUpdate'; config: DashboardConfigPayload };

export type WebviewToHostMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'toggleService'; service: ServiceId; enabled: boolean }
	| { type: 'setPollingInterval'; interval: number }
	| { type: 'setDisplayMode'; mode: UsageDisplayMode }
	| { type: 'setStatusBarTooltipLayout'; layout: StatusBarTooltipLayout }
	| { type: 'setDebugLogs'; enabled: boolean }
	| { type: 'toggleHideService'; service: string };

function serializeMetric(metric: ReturnType<typeof toUsageMetricViewModel>): SerializedUsageMetric {
	return {
		used: metric.used,
		limit: metric.limit,
		displayText: metric.displayText,
		displayValueText: metric.displayValueText,
		displayUnit: metric.displayUnit,
		displayPercent: metric.displayPercent,
		displayVerb: metric.displayVerb,
		status: metric.status,
		statusEmoji: metric.statusEmoji,
		resetTime: metric.resetTime?.toISOString(),
		resetText: metric.resetText,
	};
}

function serializeModels(models: UsageData['models']): SerializedModelUsage[] | undefined {
	return models?.map((model) => ({
		modelName: model.modelName,
		used: model.used,
		limit: model.limit,
		resetTime: model.resetTime?.toISOString(),
	}));
}

export function serializeUsageData(data: UsageData, displayMode: DashboardConfigPayload['displayMode']): SerializedUsageData {
	const viewModel = toServiceViewModel(data, displayMode);
	return {
		...serializeMetric(viewModel),
		serviceId: viewModel.serviceId,
		serviceName: viewModel.serviceName,
		totalUsed: data.totalUsed,
		totalLimit: data.totalLimit,
		shortLabel: viewModel.shortLabel,
		summaryText: viewModel.summaryText,
		progressSegments: viewModel.progressSegments,
		quotaWindows: data.quotaWindows?.map((window) => ({
			label: window.label,
			...serializeMetric(toUsageMetricViewModel(window.used, window.limit, window.resetTime, displayMode)),
		})),
		models: serializeModels(viewModel.models),
		lastUpdated: viewModel.lastUpdated.toISOString(),
	};
}

function serializeServiceDescriptor(descriptor: ServiceDescriptor): DashboardServiceDescriptor {
	return {
		id: descriptor.id,
		name: descriptor.name,
		description: descriptor.description,
	};
}

export function buildDashboardConfigPayload(configManager: ConfigManager): DashboardConfigPayload {
	return {
		displayMode: configManager.getDisplayMode(),
		statusBarTooltipLayout: configManager.getStatusBarTooltipLayout(),
		debugLogs: configManager.getDebugLogs(),
		pollingInterval: configManager.getPollingInterval(),
		services: configManager.getServicesConfig(),
		hiddenServices: configManager.getHiddenServices(),
		serviceDescriptors: getServiceDescriptors().map(serializeServiceDescriptor),
	};
}
