import { EventEmitter } from 'events';
import * as vscode from 'vscode';

export class FixedClock {
	constructor(private currentTime: number) {}

	now = (): number => this.currentTime;

	set(value: number): void {
		this.currentTime = value;
	}

	advance(ms: number): void {
		this.currentTime += ms;
	}
}

export class FakeGlobalState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
			return;
		}

		this.values.set(key, value);
	}
}

export function createExtensionContext(globalState = new FakeGlobalState()): vscode.ExtensionContext {
	return {
		globalState,
		subscriptions: [],
		extensionUri: vscode.Uri.file('/test-extension'),
	} as unknown as vscode.ExtensionContext;
}

export class FakeReadableStream extends EventEmitter {
	emitData(value: string | Buffer): void {
		this.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value));
	}
}

export class FakeWritableStream {
	readonly writes: string[] = [];
	writeError: Error | null = null;

	write(chunk: string, callback?: (error?: Error | null) => void): boolean {
		this.writes.push(chunk);
		callback?.(this.writeError);
		return this.writeError === null;
	}
}

export class FakeChildProcess extends EventEmitter {
	pid: number | undefined;
	stdin = new FakeWritableStream();
	stdout = new FakeReadableStream();
	stderr = new FakeReadableStream();
	readonly killSignals: NodeJS.Signals[] = [];

	constructor(pid = 4242) {
		super();
		this.pid = pid;
	}

	kill(signal?: NodeJS.Signals): boolean {
		if (signal) {
			this.killSignals.push(signal);
		}
		this.emit('exit', 0);
		return true;
	}

	emitJson(value: unknown): void {
		this.stdout.emitData(`${JSON.stringify(value)}\n`);
	}

	emitStdErr(value: string): void {
		this.stderr.emitData(value);
	}

	emitExit(code = 0): void {
		this.emit('exit', code);
	}
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
		},
	});
}

export function textResponse(body: string, status = 200): Response {
	return new Response(body, { status });
}

interface FsSnapshotOptions {
	files?: Record<string, string>;
	directories?: Record<string, string[]>;
	mtimes?: Record<string, number>;
}

export function createFsSnapshot(options: FsSnapshotOptions = {}) {
	const files = new Map(Object.entries(options.files ?? {}));
	const directories = new Map(Object.entries(options.directories ?? {}));
	const mtimes = new Map(Object.entries(options.mtimes ?? {}));

	const existsSync = (target: string): boolean => files.has(target) || directories.has(target);
	const readFileSync = (target: string): string => {
		const value = files.get(target);
		if (value === undefined) {
			throw new Error(`File not found: ${target}`);
		}
		return value;
	};
	const readdirSync = (target: string): string[] => {
		const value = directories.get(target);
		if (!value) {
			throw new Error(`Directory not found: ${target}`);
		}
		return value.slice();
	};
	const statSync = (target: string) => ({
		isFile: () => files.has(target),
		mtimeMs: mtimes.get(target) ?? 0,
	});

	return {
		existsSync,
		readFileSync,
		readdirSync,
		statSync,
	};
}
