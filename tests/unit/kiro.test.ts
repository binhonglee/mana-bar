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

describe('KiroProvider', () => {
	it('returns usage data from API', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const provider = new KiroProvider(
			{ access_token: 'test-access-token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/TESTPROFILE' },
			'Kiro',
			{ now: clock.now, fetch }
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

	it('returns null when API returns non-ok status', async () => {
		const fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
		const provider = new KiroProvider(
			{ access_token: 'bad-token' },
			'Kiro',
			{ fetch }
		);

		expect(await provider.getUsage()).toBeNull();
	});

	it('returns null when usageBreakdownList is empty', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ usageBreakdownList: [] }), { status: 200 }));
		const provider = new KiroProvider({ access_token: 'token' }, 'Kiro', { fetch });

		expect(await provider.getUsage()).toBeNull();
	});

	it('returns stale cached data when API throws', async () => {
		const clock = new FixedClock(Date.parse('2026-04-12T00:00:00.000Z'));
		const fetch = vi.fn(async () => new Response(JSON.stringify(USAGE_RESPONSE), { status: 200 }));
		const provider = new KiroProvider(
			{ access_token: 'token', profile_arn: 'arn:test' },
			'Kiro',
			{ now: clock.now, fetch }
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
		const provider = new KiroProvider(
			{ access_token: 'token', profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC' },
			'Kiro',
			{ fetch }
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
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {} }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
	});

	it('deduplicates when CLI and IDE share the same profile_arn', async () => {
		const exec = makeExec(TOKEN_JSON, IDE_CREDS_JSON); // same profileArn
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {} }
		);

		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe('Kiro');
	});

	it('registers two providers labeled "Kiro CLI" and "Kiro IDE" when accounts differ', async () => {
		const exec = makeExec(TOKEN_JSON, IDE_CREDS_DIFFERENT_JSON);
		const registered: Array<{ name: string }> = [];

		await discoverKiroProviders(
			(p) => registered.push({ name: p.getServiceName() }),
			{ exec, platform: 'darwin', homeDir: '/home/test', env: {} }
		);

		expect(registered).toHaveLength(2);
		expect(registered.map(r => r.name)).toEqual(['Kiro CLI', 'Kiro IDE']);
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
