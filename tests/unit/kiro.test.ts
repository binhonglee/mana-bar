import { describe, expect, it, vi } from 'vitest';
import { KiroProvider, KiroDiscoverable, discoverKiroProviders } from '../../src/providers/kiro';
import { FixedClock } from '../support/provider-test-utils';

const TOKEN_JSON = JSON.stringify({
	access_token: 'test-access-token',
	profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE',
});

const IDE_CREDS_JSON = JSON.stringify({
	accessToken: 'ide-access-token',
	profileArn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE',
});

const IDE_CREDS_DIFFERENT_JSON = JSON.stringify({
	accessToken: 'ide-access-token-2',
	profileArn: 'arn:aws:codewhisperer:us-east-1:999999999:profile/DIFFERENTPROFILE',
});

const USAGE_RESPONSE = {
	subscriptionInfo: { subscriptionTitle: 'KIRO STUDENT' },
	nextDateReset: 1777593600,
	usageBreakdownList: [{
		currentUsageWithPrecision: 120.24,
		usageLimitWithPrecision: 1000,
	}],
};

function makeExec(sqliteValue: string | null, ideCreds: string | null = null) {
	return vi.fn(async (cmd: string) => {
		if (cmd.includes('sqlite3')) return { stdout: sqliteValue ?? '' };
		if (cmd.includes('kiro-auth-token.json')) return ideCreds ? { stdout: ideCreds } : Promise.reject(new Error('not found'));
		return { stdout: '' };
	});
}

function makeReadJsonFile(ideCreds: string | null = null) {
	return async <T>(filePath: string): Promise<T | null> => {
		if (filePath.includes('kiro-auth-token.json')) {
			return ideCreds ? JSON.parse(ideCreds) as T : null;
		}
		return null;
	};
}

function makeReadSqliteValue(sqliteValue: string | null = null) {
	return vi.fn(async (dbPath: string, _query: string) => {
		if (dbPath.includes('data.sqlite3')) {
			return sqliteValue;
		}
		return null;
	});
}

describe('KiroProvider', () => {
	const CLI_SOURCE = { kind: 'cli' as const, dbPath: '/fake/data.sqlite3' };
	const IDE_SOURCE = { kind: 'ide' as const, filePath: '/fake/kiro-auth-token.json' };

	function makeCliExec(token: object) {
		return vi.fn(async (cmd: string) => {
			if (cmd.includes('sqlite3')) return { stdout: JSON.stringify(token) };
			return { stdout: '' };
		});
	}

	function makeIdeExec(token: object) {
		return vi.fn(async (cmd: string) => {
			if (cmd.includes('kiro-auth-token.json') || cmd.includes('cat')) return { stdout: JSON.stringify(token) };
			return { stdout: '' };
		});
	}

	it('returns usage data from API', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const exec = makeCliExec({ access_token: 'test-access-token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE' });
		const provider = new KiroProvider(
			{ access_token: 'test-access-token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE' },
			'Kiro',
			CLI_SOURCE,
			{ now: clock.now, fetch, exec }
		);

		const result = await provider.getUsage();

		expect(result).not.toBeNull();
		expect(result!.totalUsed).toBe(120.2);
		expect(result!.totalLimit).toBe(1000);
		expect(result!.serviceName).toBe('Kiro');
		expect(result!.resetTime).toEqual(new Date(1777593600 * 1000));
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining('/getUsageLimits?profileArn='),
			expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) })
		);
	});

	it('reloads IDE token from disk without shelling out to cat', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const exec = vi.fn(async () => ({ stdout: '' }));
		const provider = new KiroProvider(
			{ access_token: 'stale-token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE' },
			'Kiro',
			IDE_SOURCE,
			{ now: clock.now, fetch, exec, readJsonFile: makeReadJsonFile(IDE_CREDS_JSON) }
		);

		const result = await provider.getUsage();

		expect(result).not.toBeNull();
		expect(exec).not.toHaveBeenCalledWith(expect.stringContaining('cat'));
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining('/getUsageLimits?profileArn='),
			expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer ide-access-token' }) })
		);
	});

	it('reloads Windows CLI token from the bundled SQLite reader without shelling out to sqlite3', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const exec = vi.fn(async () => ({ stdout: '' }));
		const readSqliteValue = makeReadSqliteValue(TOKEN_JSON);
		const provider = new KiroProvider(
			{ access_token: 'stale-token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE' },
			'Kiro',
			{ kind: 'cli', dbPath: 'C:\\Users\\test\\AppData\\Roaming\\kiro-cli\\data.sqlite3' },
			{ now: clock.now, fetch, exec, platform: 'win32', readSqliteValue }
		);

		const result = await provider.getUsage();

		expect(result).not.toBeNull();
		expect(readSqliteValue).toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalledWith(expect.stringContaining('sqlite3'));
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining('/getUsageLimits?profileArn='),
			expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) })
		);
	});

	it('returns null when API returns non-ok status', async () => {
		const fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
		const exec = makeCliExec({ access_token: 'bad-token' });
		const provider = new KiroProvider(
			{ access_token: 'bad-token' },
			'Kiro',
			CLI_SOURCE,
			{ fetch, exec }
		);

		expect(await provider.getUsage()).toBeNull();
	});

	it('reports reauthRequired health when the API returns 401', async () => {
		const fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
		const exec = makeCliExec({ access_token: 'bad-token' });
		const provider = new KiroProvider({ access_token: 'bad-token' }, 'Kiro', CLI_SOURCE, { fetch, exec });

		await provider.getUsage();

		const health = provider.getLastServiceHealth();
		expect(health?.kind).toBe('reauthRequired');
		expect(health?.summary).toMatch(/rejected/i);
	});

	it('reports reauthRequired health when the API returns 403', async () => {
		const fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
		const exec = makeCliExec({ access_token: 'bad-token' });
		const provider = new KiroProvider({ access_token: 'bad-token' }, 'Kiro', CLI_SOURCE, { fetch, exec });

		await provider.getUsage();

		expect(provider.getLastServiceHealth()?.kind).toBe('reauthRequired');
	});

	it('skips the remote call and reports reauthRequired when local token is already expired', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn();
		const expiredToken = {
			access_token: 'expired',
			expires_at: Math.floor(Date.parse('2026-04-11T00:00:00.000Z') / 1000),
		};
		const exec = makeCliExec(expiredToken);
		const provider = new KiroProvider(
			{
				access_token: 'expired',
				expires_at_ms: Date.parse('2026-04-11T00:00:00.000Z'),
			},
			'Kiro',
			CLI_SOURCE,
			{ now: clock.now, fetch, exec }
		);

		const result = await provider.getUsage();

		expect(result).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(provider.getLastServiceHealth()?.kind).toBe('reauthRequired');
	});

	it('clears prior reauth health after a successful usage fetch', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		let status = 401;
		const fetch = vi.fn(async () => status === 200
			? new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 })
			: new Response('Unauthorized', { status }));
		const exec = makeCliExec({ access_token: 'token', profile_arn: 'arn:test' });
		const provider = new KiroProvider(
			{ access_token: 'token', profile_arn: 'arn:test' },
			'Kiro',
			CLI_SOURCE,
			{ now: clock.now, fetch, exec }
		);

		await provider.getUsage();
		expect(provider.getLastServiceHealth()?.kind).toBe('reauthRequired');

		status = 200;
		clock.advance(4 * 60 * 1000);
		const result = await provider.getUsage();
		expect(result).not.toBeNull();
		expect(provider.getLastServiceHealth()).toBeNull();
	});

	it('returns null when usageBreakdownList is empty', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ usageBreakdownList: [] }), { status: 200 }));
		const exec = makeCliExec({ access_token: 'token' });
		const provider = new KiroProvider({ access_token: 'token' }, 'Kiro', CLI_SOURCE, { fetch, exec });

		expect(await provider.getUsage()).toBeNull();
	});

	it('returns stale cached data when API throws', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const exec = makeCliExec({ access_token: 'token', profile_arn: 'arn:test' });
		const provider = new KiroProvider(
			{ access_token: 'token', profile_arn: 'arn:test' },
			'Kiro',
			CLI_SOURCE,
			{ now: clock.now, fetch, exec }
		);

		// Populate cache
		await provider.getUsage();

		// Advance past TTL and make API fail
		clock.advance(4 * 60 * 1000);
		fetch.mockRejectedValueOnce(new Error('network'));

		const result = await provider.getUsage();
		expect(result).not.toBeNull();
		expect(result!.totalUsed).toBe(120.2);
	});

	it('uses profileArn in query string when available', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const exec = makeCliExec({ access_token: 'token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC' });
		const provider = new KiroProvider(
			{ access_token: 'token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC' },
			'Kiro',
			CLI_SOURCE,
			{ fetch, exec }
		);

		await provider.getUsage();

		const url = (fetch.mock.calls[0][0] as string);
		expect(url).toContain('profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123%3Aprofile%2FABC');
	});
});

describe('discoverKiroProviders', () => {
	it('registers one provider labeled "Kiro" when only CLI creds exist', async () => {
		const exec = makeExec(TOKEN_JSON, null);
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {} }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
	});

	it('registers one provider labeled "Kiro" when only IDE creds exist', async () => {
		const exec = makeExec(null, IDE_CREDS_JSON);
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {}, readJsonFile: makeReadJsonFile(IDE_CREDS_JSON) }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
	});

	it('registers one provider labeled "Kiro" from IDE creds on Windows without cat', async () => {
		const exec = vi.fn(async () => ({ stdout: '' }));
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'win32', homeDir: 'C:\\Users\\test', env: {}, readJsonFile: makeReadJsonFile(IDE_CREDS_JSON) }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
		expect(exec).not.toHaveBeenCalledWith(expect.stringContaining('cat'));
	});

	it('registers one provider labeled "Kiro" from CLI creds on Windows via the bundled SQLite reader', async () => {
		const exec = vi.fn(async () => ({ stdout: '' }));
		const readSqliteValue = makeReadSqliteValue(TOKEN_JSON);
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'win32', homeDir: 'C:\\Users\\test', env: {}, readSqliteValue }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
		expect(readSqliteValue).toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalledWith(expect.stringContaining('sqlite3'));
	});

	it('deduplicates when CLI and IDE share the same profile_arn', async () => {
		const exec = makeExec(TOKEN_JSON, IDE_CREDS_JSON); // same profileArn
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {}, readJsonFile: makeReadJsonFile(IDE_CREDS_JSON) }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
	});

	it('prefers the IDE token when CLI token is expired but IDE token is valid (same account)', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));

		const expiredCliToken = JSON.stringify({
			access_token: 'cli-expired-token',
			profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE',
			expires_at: Math.floor(Date.parse('2026-04-11T00:00:00.000Z') / 1000), // expired
		});
		const validIdeToken = JSON.stringify({
			accessToken: 'ide-valid-token',
			profileArn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE',
			expiresAt: '2026-04-13T00:00:00.000Z', // valid
		});
		const exec = makeExec(expiredCliToken, validIdeToken);
		const providers: KiroProvider[] = [];

		await discoverKiroProviders(
			(p) => providers.push(p as KiroProvider),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {}, now: clock.now, fetch, readJsonFile: makeReadJsonFile(validIdeToken) }
		);

		expect(providers).toHaveLength(1);
		const result = await providers[0].getUsage();
		expect(result).not.toBeNull();
		expect(fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ide-valid-token' }) })
		);
	});

	it('registers two providers labeled "Kiro CLI" and "Kiro IDE" when accounts differ', async () => {
		const exec = makeExec(TOKEN_JSON, IDE_CREDS_DIFFERENT_JSON);
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {}, readJsonFile: makeReadJsonFile(IDE_CREDS_DIFFERENT_JSON) }
		);

		expect(registered).toHaveLength(2);
		expect(registered.map(r => r.name)).toEqual(['Kiro CLI', 'Kiro IDE']);
	});

	it('propagates expiry from CLI token (epoch seconds) so getUsage can flag reauth', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn();
		const cliTokenJson = JSON.stringify({
			access_token: 'cli-expired',
			profile_arn: 'arn:aws:codewhisperer:us-east-1:000:profile/X',
			expires_at: Math.floor(Date.parse('2026-04-11T00:00:00.000Z') / 1000),
		});
		const exec = makeExec(cliTokenJson, null);
		const providers: KiroProvider[] = [];

		await discoverKiroProviders(
			(p) => providers.push(p as KiroProvider),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {}, now: clock.now, fetch }
		);

		expect(providers).toHaveLength(1);
		const result = await providers[0].getUsage();
		expect(result).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(providers[0].getLastServiceHealth()?.kind).toBe('reauthRequired');
	});

	it('propagates expiry from IDE token (ISO string) so getUsage can flag reauth', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn();
		const ideCredsJson = JSON.stringify({
			accessToken: 'ide-expired',
			profileArn: 'arn:aws:codewhisperer:us-east-1:000:profile/Y',
			expiresAt: '2026-04-11T00:00:00.000Z',
		});
		const exec = makeExec(null, ideCredsJson);
		const providers: KiroProvider[] = [];

		await discoverKiroProviders(
			(p) => providers.push(p as KiroProvider),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {}, now: clock.now, fetch, readJsonFile: makeReadJsonFile(ideCredsJson) }
		);

		expect(providers).toHaveLength(1);
		const result = await providers[0].getUsage();
		expect(result).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(providers[0].getLastServiceHealth()?.kind).toBe('reauthRequired');
	});

	it('registers nothing when no creds exist', async () => {
		const exec = makeExec(null, null);
		const registered: Array<unknown> = [];

		await discoverKiroProviders(
			(p) => registered.push(p),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {} }
		);

		expect(registered).toHaveLength(0);
	});
});

describe('KiroDiscoverable', () => {
	it('delegates discovery to discoverKiroProviders', async () => {
		const exec = makeExec(TOKEN_JSON, null);
		const discoverable = new KiroDiscoverable({ exec, platform: 'darwin', homeDir: '/home/test', env: {} });
		const registered: string[] = [];

		await discoverable.discoverQuotaGroups((p) => registered.push(p.getServiceName()));

		expect(registered).toEqual(['Kiro']);
	});
});
