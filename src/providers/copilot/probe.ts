import * as vscode from 'vscode';
import {
	CopilotSurface,
	COPILOT_EXTENSION_IDS,
	NORMALIZED_COPILOT_EXTENSION_IDS,
	ResolvedCopilotProviderDeps,
	CopilotQuotaSnapshot,
	SAFE_GETTER_NAMES
} from './types';
import { classifySurfaceFromExtensionId, isRecord } from './utils';
import { CopilotParser } from './parse';
import { debugError, debugLog } from '../../logger';

export class CopilotProbeManager {
	private loggedExtensionSummaries = new Map<string, string>();
	private loggedDerivedSummaries = new Map<string, string>();
	private loggedDiscoverySummary: string | null = null;

	constructor(
		private readonly deps: ResolvedCopilotProviderDeps,
		private readonly parser: CopilotParser,
		private readonly recordSnapshot: (snapshot: CopilotQuotaSnapshot) => void,
		private readonly logParseFailure: (key: string, message: string) => void
	) { }

	async performExportProbe(reason: string): Promise<void> {
		for (const extension of this.getInstalledExtensions()) {
			const extensionId = extension.id;
			const surface = classifySurfaceFromExtensionId(extensionId);
			try {
				const activatedExports = extension.isActive ? extension.exports : await extension.activate();
				const exportValue = extension.exports ?? activatedExports;
				const summary = this.describeExportValue(exportValue);
				if (this.loggedExtensionSummaries.get(extensionId) !== summary) {
					this.loggedExtensionSummaries.set(extensionId, summary);
					debugLog(
						`[Copilot Probe] ${reason}: ${extensionId}@${extension.packageJSON?.version ?? 'unknown'} active=${extension.isActive} exports=${summary}`
					);
				}

				this.inspectExportValue(exportValue, `${extensionId}.exports`, surface, 0, new Set());
			} catch (error) {
				debugError(`[Copilot Probe] Failed to inspect ${extensionId}:`, error);
			}
		}
	}

	private getInstalledExtensions(): Array<vscode.Extension<unknown>> {
		const exactMatches = COPILOT_EXTENSION_IDS
			.map(id => this.deps.vscodeApi.extensions.getExtension(id))
			.filter((extension): extension is vscode.Extension<unknown> => Boolean(extension));
		const exactMatchIds = new Set(exactMatches.map(extension => extension.id.toLowerCase()));
		const discoveredMatches = this.deps.vscodeApi.extensions.all.filter(extension =>
			NORMALIZED_COPILOT_EXTENSION_IDS.has(extension.id.toLowerCase())
			&& !exactMatchIds.has(extension.id.toLowerCase())
		);
		const matches = [...exactMatches, ...discoveredMatches];
		const discoverySummary = matches.map(extension => extension.id).sort().join(', ') || 'none';

		if (this.loggedDiscoverySummary !== discoverySummary) {
			this.loggedDiscoverySummary = discoverySummary;
			debugLog(`[Copilot Probe] discovered Copilot extensions: ${discoverySummary}`);
		}

		return matches;
	}

	private inspectExportValue(
		value: unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		if (depth > 4 || value === null || value === undefined) {
			return;
		}

		const fromQuotaInfo = this.parser.normalizeQuotaInfoValue(value, `${path}.quotaInfo`, 'export-probe', surface);
		if (fromQuotaInfo) {
			this.recordSnapshot(fromQuotaInfo);
		}

		const fromCopilotToken = this.normalizeCopilotTokenValue(value, `${path}.copilotToken.quotaInfo`, surface);
		if (fromCopilotToken) {
			this.recordSnapshot(fromCopilotToken);
		}

		const fromQuotaSnapshots = this.parser.normalizeQuotaSnapshotsValue(value, path, 'export-probe', surface);
		if (fromQuotaSnapshots) {
			this.recordSnapshot(fromQuotaSnapshots);
		}

		if (typeof value !== 'object' && typeof value !== 'function') {
			return;
		}

		const objectValue = value as object;
		if (seen.has(objectValue)) {
			return;
		}
		seen.add(objectValue);

		this.inspectKnownMethodResults(value, path, surface, depth, seen);
		this.inspectKnownGetterResults(value, path, surface, depth, seen);

		if (Array.isArray(value)) {
			for (const [index, item] of value.slice(0, 10).entries()) {
				this.inspectExportValue(item, `${path}[${index}]`, surface, depth + 1, seen);
			}
			return;
		}

		const keys = Reflect.ownKeys(value).slice(0, 20);
		for (const key of keys) {
			const entry = this.readInspectableProperty(value, key, path);
			if (entry === undefined) {
				continue;
			}
			if (typeof entry === 'function') {
				continue;
			}
			this.inspectExportValue(entry, `${path}.${String(key)}`, surface, depth + 1, seen);
		}
	}

	private normalizeCopilotTokenValue(
		value: unknown,
		detail: string,
		surface: CopilotSurface
	): CopilotQuotaSnapshot | null {
		if (!isRecord(value) || !('copilotToken' in value)) {
			return null;
		}

		return this.parser.normalizeQuotaInfoValue((value as { copilotToken?: unknown }).copilotToken, detail, 'export-probe', surface);
	}

	private inspectKnownMethodResults(
		value: unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		const getAPIMethod = this.readCallableProperty(value, 'getAPI');
		if (getAPIMethod) {
			this.inspectDerivedValue(() => getAPIMethod.call(value, 1), `${path}.getAPI(1)`, surface, depth, seen);
		}

		const getContextProviderAPIMethod = this.readCallableProperty(value, 'getContextProviderAPI');
		if (getContextProviderAPIMethod) {
			this.inspectDerivedValue(() => getContextProviderAPIMethod.call(value, undefined), `${path}.getContextProviderAPI()`, surface, depth, seen);
		}
	}

	private inspectKnownGetterResults(
		value: unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		let prototype = Object.getPrototypeOf(value);
		let prototypeDepth = 0;

		while (prototype && prototype !== Object.prototype && prototype !== Function.prototype && prototypeDepth < 2) {
			for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) {
				if (!SAFE_GETTER_NAMES.has(name) || typeof descriptor.get !== 'function') {
					continue;
				}

				this.inspectDerivedValue(
					() => descriptor.get?.call(value),
					`${path}.${name}`,
					surface,
					depth,
					seen
				);
			}

			prototype = Object.getPrototypeOf(prototype);
			prototypeDepth += 1;
		}
	}

	private inspectDerivedValue(
		compute: () => unknown,
		path: string,
		surface: CopilotSurface,
		depth: number,
		seen: Set<object>
	): void {
		try {
			const derivedValue = compute();
			if (derivedValue === undefined) {
				return;
			}

			this.logDerivedSummary(path, derivedValue);
			this.inspectExportValue(derivedValue, path, surface, depth + 1, seen);
		} catch (error) {
			this.logParseFailure(path, `[Copilot Probe] Failed to inspect ${path}: ${String(error)}`);
		}
	}

	private describeExportValue(value: unknown): string {
		if (value === null || value === undefined) {
			return String(value);
		}

		if (Array.isArray(value)) {
			return `array(length=${value.length})`;
		}

		if (typeof value !== 'object') {
			return typeof value;
		}

		const keys = Reflect.ownKeys(value)
			.map(key => String(key))
			.slice(0, 12);
		const prototype = Object.getPrototypeOf(value);
		const prototypeKeys = prototype && prototype !== Object.prototype
			? Object.getOwnPropertyNames(prototype)
				.filter(key => key !== 'constructor')
				.slice(0, 8)
			: [];

		const ownSummary = keys.length === 0 ? 'keys=none' : `keys=${keys.join(', ')}`;
		if (prototypeKeys.length === 0) {
			return `object(${ownSummary})`;
		}
		return `object(${ownSummary}; proto=${prototypeKeys.join(', ')})`;
	}

	private readInspectableProperty(value: unknown, key: PropertyKey, path: string): unknown {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) {
			return undefined;
		}

		if ('value' in descriptor) {
			return descriptor.value;
		}

		if (!SAFE_GETTER_NAMES.has(String(key)) || typeof descriptor.get !== 'function') {
			return undefined;
		}

		try {
			return descriptor.get.call(value);
		} catch (error) {
			this.logParseFailure(`${path}.${String(key)}`, `[Copilot Probe] Failed to inspect ${path}.${String(key)}: ${String(error)}`);
			return undefined;
		}
	}

	private readCallableProperty(value: unknown, propertyName: string): ((...args: unknown[]) => unknown) | null {
		if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
			return null;
		}

		const candidate = Reflect.get(value, propertyName);
		return typeof candidate === 'function' ? candidate as (...args: unknown[]) => unknown : null;
	}

	private logDerivedSummary(path: string, value: unknown): void {
		const summary = this.describeExportValue(value);
		if (this.loggedDerivedSummaries.get(path) === summary) {
			return;
		}

		this.loggedDerivedSummaries.set(path, summary);
		debugLog(`[Copilot Probe] ${path} => ${summary}`);
	}
}
