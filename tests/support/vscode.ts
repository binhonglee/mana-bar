import * as path from 'path';

type Listener<T> = (event: T) => unknown;

function registerListener<T>(
	register: (listener: Listener<T>) => Disposable,
	listener: Listener<T>,
	thisArg?: unknown,
	disposables?: Disposable[]
): Disposable {
	const disposable = register((event) => listener.call(thisArg, event));
	disposables?.push(disposable);
	return disposable;
}

export class Disposable {
	constructor(private readonly callback: () => void = () => {}) {}

	dispose(): void {
		this.callback();
	}
}

export class EventEmitter<T> {
	private listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>, thisArg?: unknown, disposables?: Disposable[]): Disposable =>
		registerListener((wrapped) => {
			this.listeners.add(wrapped);
			return new Disposable(() => this.listeners.delete(wrapped));
		}, listener, thisArg, disposables);

	fire(event: T): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

export class ThemeIcon {
	constructor(public readonly id: string) {}
}

export enum TreeItemCollapsibleState {
	None = 0,
	Collapsed = 1,
	Expanded = 2,
}

export class TreeItem {
	public description?: string;
	public id?: string;
	public iconPath?: unknown;

	constructor(
		public readonly label: string,
		public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
	) {}
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2,
}

export enum ViewColumn {
	One = 1,
}

export enum ConfigurationTarget {
	Global = 1,
}

export class MarkdownString {
	constructor(public readonly value: string) {}
}

class TestUri {
	readonly scheme = 'file';
	readonly path: string;

	constructor(public readonly fsPath: string) {
		this.path = fsPath;
	}

	toString(): string {
		return this.fsPath;
	}
}

function toFsPath(value: TestUri | { fsPath: string } | string): string {
	if (typeof value === 'string') {
		return value;
	}
	return value.fsPath;
}

interface TestStatusBarItem {
	text: string;
	tooltip: unknown;
	backgroundColor: unknown;
	command: unknown;
	visible: boolean;
	disposed: boolean;
	show: () => void;
	hide: () => void;
	dispose: () => void;
}

class TestWebview {
	html = '';
	options: unknown;
	cspSource = 'vscode-test-csp';
	readonly postedMessages: unknown[] = [];
	private readonly receiveEmitter = new EventEmitter<unknown>();

	constructor(options: unknown) {
		this.options = options;
	}

	postMessage(message: unknown): Thenable<boolean> {
		this.postedMessages.push(message);
		return Promise.resolve(true);
	}

	onDidReceiveMessage(listener: Listener<unknown>, thisArg?: unknown, disposables?: Disposable[]): Disposable {
		return registerListener(this.receiveEmitter.event, listener, thisArg, disposables);
	}

	asWebviewUri(uri: TestUri | { fsPath: string } | string): string {
		return `webview:${toFsPath(uri)}`;
	}

	receiveMessage(message: unknown): void {
		this.receiveEmitter.fire(message);
	}
}

class TestWebviewPanel {
	readonly webview: TestWebview;
	readonly revealCalls: Array<number | undefined> = [];
	visible = true;
	active = true;
	disposed = false;
	private readonly disposeEmitter = new EventEmitter<void>();

	constructor(
		public readonly viewType: string,
		public title: string,
		public viewColumn: number | undefined,
		options: unknown
	) {
		this.webview = new TestWebview(options);
	}

	reveal(column?: number): void {
		this.viewColumn = column;
		this.revealCalls.push(column);
	}

	onDidDispose(listener: Listener<void>, thisArg?: unknown, disposables?: Disposable[]): Disposable {
		return registerListener(this.disposeEmitter.event, listener, thisArg, disposables);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.visible = false;
		this.disposeEmitter.fire();
	}
}

interface TestTreeView {
	id: string;
	options: unknown;
	disposed: boolean;
	dispose: () => void;
}

interface TestExtension<T = unknown> {
	id: string;
	packageJSON: Record<string, unknown>;
	isActive: boolean;
	exports: T;
	activate: () => Promise<T>;
}

interface TestAuthenticationSessionAccountInformation {
	id: string;
	label: string;
}

interface TestAuthenticationSession {
	id: string;
	accessToken: string;
	idToken?: string;
	account: TestAuthenticationSessionAccountInformation;
	scopes: readonly string[];
}

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();
const configurationState = new Map<string, Record<string, unknown>>();
const configurationEmitter = new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>();
const extensionsEmitter = new EventEmitter<void>();
const extensionRegistry = new Map<string, TestExtension>();
const authenticationSessionsEmitter = new EventEmitter<{ provider: { id: string; label: string } }>();
const authenticationSessionRegistry = new Map<string, TestAuthenticationSession[]>();
const serializers = new Map<string, unknown>();
const createdTreeViews: TestTreeView[] = [];
const createdWebviewPanels: TestWebviewPanel[] = [];
const informationMessages: string[] = [];
const statusBarItems: TestStatusBarItem[] = [];

function ensureConfigSection(section: string): Record<string, unknown> {
	const current = configurationState.get(section);
	if (current) {
		return current;
	}
	const next: Record<string, unknown> = {};
	configurationState.set(section, next);
	return next;
}

function fireConfigurationChange(changedPath: string): void {
	configurationEmitter.fire({
		affectsConfiguration: (section: string) =>
			section === changedPath
			|| changedPath.startsWith(`${section}.`)
			|| section.startsWith(`${changedPath}.`),
	});
}

class TestConfiguration {
	constructor(private readonly section: string) {}

	get<T>(key: string, defaultValue?: T): T {
		const sectionValues = ensureConfigSection(this.section);
		const value = sectionValues[key];
		return (value === undefined ? defaultValue : value) as T;
	}

	async update(key: string, value: unknown, _target?: ConfigurationTarget): Promise<void> {
		const sectionValues = ensureConfigSection(this.section);
		sectionValues[key] = value;
		fireConfigurationChange(`${this.section}.${key}`);
	}
}

export const commands = {
	registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable {
		commandRegistry.set(command, callback);
		return new Disposable(() => commandRegistry.delete(command));
	},
	async executeCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
		const callback = commandRegistry.get(command);
		if (!callback) {
			return undefined;
		}
		return callback(...args) as T;
	},
};

export const workspace = {
	getConfiguration(section = ''): TestConfiguration {
		return new TestConfiguration(section);
	},
	onDidChangeConfiguration(listener: Listener<{ affectsConfiguration: (section: string) => boolean }>, thisArg?: unknown, disposables?: Disposable[]): Disposable {
		return registerListener(configurationEmitter.event, listener, thisArg, disposables);
	},
};

export const window = {
	activeTextEditor: undefined as { viewColumn?: number } | undefined,
	createStatusBarItem: (): TestStatusBarItem => {
		const item: TestStatusBarItem = {
			text: '',
			tooltip: undefined,
			backgroundColor: undefined,
			command: undefined,
			visible: false,
			disposed: false,
			show() {
				item.visible = true;
			},
			hide() {
				item.visible = false;
			},
			dispose() {
				item.disposed = true;
			},
		};
		statusBarItems.push(item);
		return item;
	},
	createTreeView: (id: string, options: unknown): TestTreeView => {
		const treeView: TestTreeView = {
			id,
			options,
			disposed: false,
			dispose() {
				treeView.disposed = true;
			},
		};
		createdTreeViews.push(treeView);
		return treeView;
	},
	createWebviewPanel: (viewType: string, title: string, column: number | undefined, options: unknown): TestWebviewPanel => {
		const panel = new TestWebviewPanel(viewType, title, column, options);
		createdWebviewPanels.push(panel);
		return panel;
	},
	registerWebviewPanelSerializer: (viewType: string, serializer: unknown): Disposable => {
		serializers.set(viewType, serializer);
		return new Disposable(() => serializers.delete(viewType));
	},
	showInformationMessage: async (message: string) => {
		informationMessages.push(message);
		return undefined;
	},
};

export const extensions = {
	get all(): TestExtension[] {
		return [...extensionRegistry.values()];
	},
	getExtension<T>(id: string): TestExtension<T> | undefined {
		return extensionRegistry.get(id) as TestExtension<T> | undefined;
	},
	onDidChange(listener: Listener<void>, thisArg?: unknown, disposables?: Disposable[]): Disposable {
		return registerListener(extensionsEmitter.event, listener, thisArg, disposables);
	},
};

export const authentication = {
	async getSession(
		providerId: string,
		scopeListOrRequest: readonly string[] | { fallbackScopes?: readonly string[] },
		options?: { account?: TestAuthenticationSessionAccountInformation }
	): Promise<TestAuthenticationSession | undefined> {
		const requestedScopes = Array.isArray(scopeListOrRequest)
			? [...scopeListOrRequest]
			: [...(scopeListOrRequest.fallbackScopes ?? [])];
		const sessions = authenticationSessionRegistry.get(providerId) ?? [];

		return sessions.find(session =>
			(!options?.account || session.account.id === options.account.id)
			&& requestedScopes.every(scope => session.scopes.includes(scope))
		);
	},
	async getAccounts(providerId: string): Promise<readonly TestAuthenticationSessionAccountInformation[]> {
		const sessions = authenticationSessionRegistry.get(providerId) ?? [];
		const accounts = new Map<string, TestAuthenticationSessionAccountInformation>();

		for (const session of sessions) {
			accounts.set(session.account.id, session.account);
		}

		return [...accounts.values()];
	},
	onDidChangeSessions(
		listener: Listener<{ provider: { id: string; label: string } }>,
		thisArg?: unknown,
		disposables?: Disposable[]
	): Disposable {
		return registerListener(authenticationSessionsEmitter.event, listener, thisArg, disposables);
	},
};

export const Uri = {
	joinPath(base: TestUri | { fsPath: string } | string, ...parts: string[]): TestUri {
		return new TestUri(path.join(toFsPath(base), ...parts));
	},
	file(value: string): TestUri {
		return new TestUri(value);
	},
};

export const __testing = {
	getLastStatusBarItem: (): TestStatusBarItem | undefined => statusBarItems.at(-1),
	resetStatusBarItem: (): void => {
		statusBarItems.length = 0;
	},
	reset(): void {
		commandRegistry.clear();
		configurationState.clear();
		extensionRegistry.clear();
		authenticationSessionRegistry.clear();
		serializers.clear();
		createdTreeViews.length = 0;
		createdWebviewPanels.length = 0;
		informationMessages.length = 0;
		statusBarItems.length = 0;
		window.activeTextEditor = undefined;
	},
	setConfiguration(section: string, key: string, value: unknown): void {
		ensureConfigSection(section)[key] = value;
	},
	getConfiguration(section: string, key: string): unknown {
		return ensureConfigSection(section)[key];
	},
	getCreatedTreeViews(): TestTreeView[] {
		return createdTreeViews.slice();
	},
	getCreatedWebviewPanels(): TestWebviewPanel[] {
		return createdWebviewPanels.slice();
	},
	dispatchWebviewMessage(panel: TestWebviewPanel, message: unknown): void {
		panel.webview.receiveMessage(message);
	},
	getRegisteredSerializer(viewType: string): unknown {
		return serializers.get(viewType);
	},
	getInformationMessages(): string[] {
		return informationMessages.slice();
	},
	getRegisteredCommands(): string[] {
		return [...commandRegistry.keys()];
	},
	registerExtension<T>(options: {
		id: string;
		packageJSON?: Record<string, unknown>;
		isActive?: boolean;
		exports?: T;
		activate?: () => Promise<T> | T;
	}): TestExtension<T> {
		const extension: TestExtension<T> = {
			id: options.id,
			packageJSON: options.packageJSON ?? {},
			isActive: options.isActive ?? false,
			exports: options.exports as T,
			activate: async () => {
				extension.isActive = true;
				const nextExports = options.activate ? await options.activate() : extension.exports;
				extension.exports = nextExports;
				return nextExports;
			},
		};
		extensionRegistry.set(extension.id, extension);
		extensionsEmitter.fire();
		return extension;
	},
	getExtensions(): TestExtension[] {
		return [...extensionRegistry.values()];
	},
	registerAuthenticationSession(options: {
		providerId: string;
		session: TestAuthenticationSession;
	}): TestAuthenticationSession {
		const sessions = authenticationSessionRegistry.get(options.providerId) ?? [];
		sessions.push(options.session);
		authenticationSessionRegistry.set(options.providerId, sessions);
		authenticationSessionsEmitter.fire({
			provider: {
				id: options.providerId,
				label: options.providerId,
			},
		});
		return options.session;
	},
};
