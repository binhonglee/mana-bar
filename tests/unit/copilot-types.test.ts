import { describe, expect, it } from 'vitest';
import {
	COPILOT_EXTENSION_IDS,
	NORMALIZED_COPILOT_EXTENSION_IDS,
	QUOTA_HEADER_PRIORITY,
	SAFE_GETTER_NAMES,
	AUTH_FETCH_TTL,
	COPILOT_DEFAULT_ENTITLEMENT_URL,
} from '../../src/providers/copilot/types';

describe('Copilot types constants', () => {
	describe('COPILOT_EXTENSION_IDS', () => {
		it('contains GitHub.copilot', () => {
			expect(COPILOT_EXTENSION_IDS).toContain('GitHub.copilot');
		});

		it('contains GitHub.copilot-chat', () => {
			expect(COPILOT_EXTENSION_IDS).toContain('GitHub.copilot-chat');
		});

		it('contains exactly 2 extension IDs', () => {
			expect(COPILOT_EXTENSION_IDS).toHaveLength(2);
		});
	});

	describe('NORMALIZED_COPILOT_EXTENSION_IDS', () => {
		it('contains lowercase versions of all extension IDs', () => {
			for (const id of COPILOT_EXTENSION_IDS) {
				expect(NORMALIZED_COPILOT_EXTENSION_IDS.has(id.toLowerCase())).toBe(true);
			}
		});

		it('contains github.copilot', () => {
			expect(NORMALIZED_COPILOT_EXTENSION_IDS.has('github.copilot')).toBe(true);
		});

		it('contains github.copilot-chat', () => {
			expect(NORMALIZED_COPILOT_EXTENSION_IDS.has('github.copilot-chat')).toBe(true);
		});

		it('has the same size as COPILOT_EXTENSION_IDS', () => {
			expect(NORMALIZED_COPILOT_EXTENSION_IDS.size).toBe(COPILOT_EXTENSION_IDS.length);
		});
	});

	describe('QUOTA_HEADER_PRIORITY', () => {
		it('lists premium_interactions first', () => {
			expect(QUOTA_HEADER_PRIORITY[0]).toBe('x-quota-snapshot-premium_interactions');
		});

		it('lists premium_models second', () => {
			expect(QUOTA_HEADER_PRIORITY[1]).toBe('x-quota-snapshot-premium_models');
		});

		it('lists chat third', () => {
			expect(QUOTA_HEADER_PRIORITY[2]).toBe('x-quota-snapshot-chat');
		});

		it('contains exactly 3 headers in priority order', () => {
			expect(QUOTA_HEADER_PRIORITY).toHaveLength(3);
			expect([...QUOTA_HEADER_PRIORITY]).toEqual([
				'x-quota-snapshot-premium_interactions',
				'x-quota-snapshot-premium_models',
				'x-quota-snapshot-chat',
			]);
		});
	});

	describe('SAFE_GETTER_NAMES', () => {
		it('contains quotaInfo', () => {
			expect(SAFE_GETTER_NAMES.has('quotaInfo')).toBe(true);
		});

		it('contains raw', () => {
			expect(SAFE_GETTER_NAMES.has('raw')).toBe(true);
		});

		it('contains userInfo', () => {
			expect(SAFE_GETTER_NAMES.has('userInfo')).toBe(true);
		});

		it('contains copilotToken', () => {
			expect(SAFE_GETTER_NAMES.has('copilotToken')).toBe(true);
		});

		it('contains token', () => {
			expect(SAFE_GETTER_NAMES.has('token')).toBe(true);
		});

		it('contains exactly 5 getter names', () => {
			expect(SAFE_GETTER_NAMES.size).toBe(5);
		});
	});

	describe('AUTH_FETCH_TTL', () => {
		it('equals 60000 milliseconds', () => {
			expect(AUTH_FETCH_TTL).toBe(60000);
		});

		it('equals 60 seconds in milliseconds', () => {
			expect(AUTH_FETCH_TTL).toBe(60 * 1000);
		});
	});

	describe('COPILOT_DEFAULT_ENTITLEMENT_URL', () => {
		it('equals the expected GitHub API URL', () => {
			expect(COPILOT_DEFAULT_ENTITLEMENT_URL).toBe('https://api.github.com/copilot_internal/user');
		});
	});
});
