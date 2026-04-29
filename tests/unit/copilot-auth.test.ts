import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing } from '../support/vscode';
import { CopilotAuthManager } from '../../src/providers/copilot/auth';
import { createTestDeps, type TestDeps } from '../support/copilot-test-utils';
import {
	COPILOT_DEFAULT_PROVIDER_ID,
	COPILOT_ENTERPRISE_PROVIDER_ID,
	COPILOT_ENTERPRISE_SECTION,
	COPILOT_ENTERPRISE_URI_KEY,
} from '../../src/providers/copilot/types';

describe('CopilotAuthManager', () => {
	let testDeps: TestDeps;
	let authManager: CopilotAuthManager;

	beforeEach(() => {
		__testing.reset();
		testDeps = createTestDeps();
		authManager = new CopilotAuthManager(testDeps.deps, testDeps.logParseFailure);
	});

	afterEach(() => {
		__testing.reset();
		testDeps = undefined!;
		authManager = undefined!;
	});

	describe('findCopilotSession', () => {
		describe('with matching scopes', () => {
			it('returns a session matching user:email scope set', async () => {
				__testing.registerAuthenticationSession({
					providerId: 'github',
					session: {
						id: 'session-1',
						accessToken: 'gho_token123',
						account: { id: 'user-1', label: 'testuser' },
						scopes: ['user:email'],
					},
				});

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.id).toBe('session-1');
				expect(result!.accessToken).toBe('gho_token123');
				expect(result!.account.id).toBe('user-1');
				expect(result!.account.label).toBe('testuser');
				expect(result!.scopes).toEqual(['user:email']);
			});

			it('returns a session matching read:user scope set', async () => {
				__testing.registerAuthenticationSession({
					providerId: 'github',
					session: {
						id: 'session-2',
						accessToken: 'gho_readuser',
						account: { id: 'user-2', label: 'reader' },
						scopes: ['read:user'],
					},
				});

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.id).toBe('session-2');
				expect(result!.accessToken).toBe('gho_readuser');
			});

			it('returns a session matching the full scope set', async () => {
				__testing.registerAuthenticationSession({
					providerId: 'github',
					session: {
						id: 'session-3',
						accessToken: 'gho_full',
						account: { id: 'user-3', label: 'fulluser' },
						scopes: ['read:user', 'user:email', 'repo', 'workflow'],
					},
				});

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.id).toBe('session-3');
			});

			it('prefers the first matching scope set (user:email)', async () => {
				__testing.registerAuthenticationSession({
					providerId: 'github',
					session: {
						id: 'session-email',
						accessToken: 'gho_email',
						account: { id: 'user-1', label: 'testuser' },
						scopes: ['user:email', 'read:user', 'repo', 'workflow'],
					},
				});

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.id).toBe('session-email');
			});
		});

		describe('fallback to any-scope session', () => {
			it('falls back to any-scope session when no scope set matches', async () => {
				// Register a session with scopes that don't match any COPILOT_SCOPE_SETS
				__testing.registerAuthenticationSession({
					providerId: 'github',
					session: {
						id: 'session-other',
						accessToken: 'gho_other',
						account: { id: 'user-1', label: 'otheruser' },
						scopes: ['notifications'],
					},
				});

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.id).toBe('session-other');
				expect(result!.accessToken).toBe('gho_other');
			});

			it('returns null when no sessions exist at all', async () => {
				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).toBeNull();
			});
		});

		describe('with persisted secrets', () => {
			it('returns a persisted session when no VS Code auth sessions exist', async () => {
				const persistedSessions = JSON.stringify([
					{
						id: 'persisted-1',
						accessToken: 'gho_persisted',
						account: { id: 'p-user', label: 'persisted-user' },
						scopes: ['user:email'],
					},
				]);
				vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.accessToken).toBe('gho_persisted');
				expect(result!.account.label).toBe('persisted-user');
			});

			it('returns null and logs parse failure for malformed JSON', async () => {
				vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue('not valid json{{{');

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).toBeNull();
				expect(testDeps.logParseFailure).toHaveBeenCalledWith(
					expect.stringContaining('persisted-session-parse:github'),
					expect.stringContaining('Failed to parse persisted')
				);
			});

			it('returns null when persisted secret is not an array', async () => {
				vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(JSON.stringify({ not: 'array' }));

				const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
				expect(result).toBeNull();
				expect(testDeps.logParseFailure).toHaveBeenCalledWith(
					expect.stringContaining('persisted-session-shape:github'),
					expect.stringContaining('did not contain a session array')
				);
			});
		});

		describe('enterprise provider ID with custom URI', () => {
			it('uses enterprise hostname in persisted secret service ID', async () => {
				__testing.setConfiguration(COPILOT_ENTERPRISE_SECTION, COPILOT_ENTERPRISE_URI_KEY, 'https://github.mycompany.com/api/v3');

				const persistedSessions = JSON.stringify([
					{
						id: 'ent-1',
						accessToken: 'gho_enterprise',
						account: { id: 'ent-user', label: 'enterprise-user' },
						scopes: ['user:email'],
					},
				]);
				vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

				const result = await authManager.findCopilotSession(COPILOT_ENTERPRISE_PROVIDER_ID);
				expect(result).not.toBeNull();
				expect(result!.accessToken).toBe('gho_enterprise');

				// Verify readPersistedSecret was called with the enterprise service ID
				expect(testDeps.deps.readPersistedSecret).toHaveBeenCalledWith(
					'github.mycompany.com/api/v3.ghes.auth'
				);
			});

			it('falls back to default service ID when no URI is configured', async () => {
				vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(null);

				await authManager.findCopilotSession(COPILOT_ENTERPRISE_PROVIDER_ID);

				expect(testDeps.deps.readPersistedSecret).toHaveBeenCalledWith(
					'github-enterprise.auth'
				);
			});

			it('falls back to default service ID when URI is invalid', async () => {
				__testing.setConfiguration(COPILOT_ENTERPRISE_SECTION, COPILOT_ENTERPRISE_URI_KEY, 'not-a-valid-url');
				vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(null);

				await authManager.findCopilotSession(COPILOT_ENTERPRISE_PROVIDER_ID);

				expect(testDeps.deps.readPersistedSecret).toHaveBeenCalledWith(
					'github-enterprise.auth'
				);
			});
		});
	});

	describe('hasPersistedSession', () => {
		it('returns true when persisted sessions exist', async () => {
			const persistedSessions = JSON.stringify([
				{
					id: 'persisted-1',
					accessToken: 'gho_token',
					account: { id: 'user-1', label: 'user' },
					scopes: ['user:email'],
				},
			]);
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

			const result = await authManager.hasPersistedSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).toBe(true);
		});

		it('returns false when no persisted sessions exist', async () => {
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(null);

			const result = await authManager.hasPersistedSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).toBe(false);
		});

		it('returns false when persisted secret is empty array', async () => {
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(JSON.stringify([]));

			const result = await authManager.hasPersistedSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).toBe(false);
		});
	});

	describe('filtering invalid persisted session entries', () => {
		it('filters out entries with missing accessToken', async () => {
			const persistedSessions = JSON.stringify([
				{
					id: 'no-token',
					account: { id: 'user-1', label: 'user' },
					scopes: ['user:email'],
				},
				{
					id: 'valid',
					accessToken: 'gho_valid',
					account: { id: 'user-2', label: 'valid-user' },
					scopes: ['user:email'],
				},
			]);
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

			const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('valid');
			expect(result!.accessToken).toBe('gho_valid');
		});

		it('filters out entries with empty scopes array', async () => {
			const persistedSessions = JSON.stringify([
				{
					id: 'empty-scopes',
					accessToken: 'gho_empty',
					account: { id: 'user-1', label: 'user' },
					scopes: [],
				},
				{
					id: 'valid',
					accessToken: 'gho_valid',
					account: { id: 'user-2', label: 'valid-user' },
					scopes: ['read:user'],
				},
			]);
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

			const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('valid');
		});

		it('filters out entries with non-string scopes', async () => {
			const persistedSessions = JSON.stringify([
				{
					id: 'bad-scopes',
					accessToken: 'gho_bad',
					account: { id: 'user-1', label: 'user' },
					scopes: [123, null, undefined],
				},
				{
					id: 'valid',
					accessToken: 'gho_valid',
					account: { id: 'user-2', label: 'valid-user' },
					scopes: ['user:email'],
				},
			]);
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

			const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('valid');
		});

		it('filters out non-object entries', async () => {
			const persistedSessions = JSON.stringify([
				'not-an-object',
				42,
				null,
				{
					id: 'valid',
					accessToken: 'gho_valid',
					account: { id: 'user-2', label: 'valid-user' },
					scopes: ['user:email'],
				},
			]);
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

			const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('valid');
		});

		it('returns null when all entries are invalid', async () => {
			const persistedSessions = JSON.stringify([
				{ id: 'no-token', scopes: ['user:email'] },
				{ id: 'empty-scopes', accessToken: 'gho_x', scopes: [] },
			]);
			vi.mocked(testDeps.deps.readPersistedSecret!).mockResolvedValue(persistedSessions);

			const result = await authManager.findCopilotSession(COPILOT_DEFAULT_PROVIDER_ID);
			expect(result).toBeNull();
		});
	});
});
