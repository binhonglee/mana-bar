import * as fs from 'fs/promises';
import * as path from 'path';

interface SqlJsStatement {
	step(): boolean;
	get(): unknown[];
	free(): void;
}

interface SqlJsDatabase {
	prepare(sql: string): SqlJsStatement;
	close(): void;
}

interface SqlJsModule {
	Database: new (data: Uint8Array) => SqlJsDatabase;
}

type InitSqlJs = (config?: {
	locateFile?: (file: string) => string;
}) => Promise<SqlJsModule>;

let sqlJsPromise: Promise<SqlJsModule> | null = null;

async function loadSqlJs(): Promise<SqlJsModule> {
	if (!sqlJsPromise) {
		const initSqlJs = require('sql.js') as InitSqlJs;
		const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
		sqlJsPromise = initSqlJs({
			locateFile: (file) => (file === 'sql-wasm.wasm'
				? wasmPath
				: path.join(path.dirname(wasmPath), file)),
		});
	}

	return sqlJsPromise;
}

export async function readSqliteStringValue(dbPath: string, query: string): Promise<string | null> {
	const values = await readSqliteStringValues(dbPath, query);
	return values[0] ?? null;
}

export async function readSqliteStringValues(dbPath: string, query: string): Promise<string[]> {
	const SQL = await loadSqlJs();
	const fileContents = await fs.readFile(dbPath);
	const db = new SQL.Database(new Uint8Array(fileContents));

	try {
		const statement = db.prepare(query);
		try {
			const values: string[] = [];
			while (statement.step()) {
				const [value] = statement.get();
				if (value === undefined || value === null) {
					continue;
				}
				values.push(typeof value === 'string' ? value : String(value));
			}
			return values;
		} finally {
			statement.free();
		}
	} finally {
		db.close();
	}
}
