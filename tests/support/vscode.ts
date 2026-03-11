type Listener<T> = (event: T) => unknown;

export class Disposable {
	constructor(private readonly callback: () => void = () => {}) {}

	dispose(): void {
		this.callback();
	}
}

export class EventEmitter<T> {
	private listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>): Disposable => {
		this.listeners.add(listener);
		return new Disposable(() => this.listeners.delete(listener));
	};

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

let lastStatusBarItem: {
	text: string;
	tooltip: unknown;
	backgroundColor: unknown;
	command: unknown;
	show: () => void;
	dispose: () => void;
} | undefined;

export const commands = {
	registerCommand: () => new Disposable(),
	executeCommand: async () => undefined,
};

export const workspace = {
	getConfiguration: () => ({
		get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
		update: async () => undefined,
	}),
	onDidChangeConfiguration: () => new Disposable(),
};

export const window = {
	activeTextEditor: undefined,
	createStatusBarItem: () => {
		lastStatusBarItem = {
			text: '',
			tooltip: undefined as unknown,
			backgroundColor: undefined as unknown,
			command: undefined as unknown,
			show: () => undefined,
			dispose: () => undefined,
		};
		return lastStatusBarItem;
	},
	createTreeView: () => ({ dispose: () => undefined }),
	createWebviewPanel: () => {
		throw new Error('createWebviewPanel is not implemented in the unit-test vscode mock');
	},
	showInformationMessage: async () => undefined,
};

export const __testing = {
	getLastStatusBarItem: () => lastStatusBarItem,
	resetStatusBarItem: () => {
		lastStatusBarItem = undefined;
	},
};

export const Uri = {
	joinPath: (...parts: unknown[]) => parts[0],
	file: (value: string) => ({ fsPath: value, toString: () => value }),
};
