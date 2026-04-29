import { describe, expect, it } from 'vitest';
import { UsageProvider } from '../../src/providers/base';
import { ServiceHealth, ServiceId, UsageData } from '../../src/types';

/**
 * Concrete test subclass that implements the abstract members of UsageProvider
 * without overriding any default methods.
 */
class TestProvider extends UsageProvider {
	readonly serviceId: ServiceId = 'claudeCode';

	getServiceName(): string {
		return 'Test Provider';
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getUsage(): Promise<UsageData | null> {
		return null;
	}

	async getModels(): Promise<string[]> {
		return [];
	}
}

/**
 * Concrete subclass that overrides getLastServiceHealth to return a custom value.
 */
class HealthOverrideProvider extends TestProvider {
	private health: ServiceHealth | null = null;

	setHealth(health: ServiceHealth | null): void {
		this.health = health;
	}

	override getLastServiceHealth(): ServiceHealth | null {
		return this.health;
	}
}

describe('UsageProvider base class', () => {
	describe('getLastServiceHealth', () => {
		it('returns null by default when not overridden', () => {
			const provider = new TestProvider();
			expect(provider.getLastServiceHealth()).toBeNull();
		});
	});

	describe('clearCache', () => {
		it('completes without error when not overridden', () => {
			const provider = new TestProvider();
			expect(() => provider.clearCache()).not.toThrow();
		});
	});

	describe('dispose', () => {
		it('is undefined by default', () => {
			const provider = new TestProvider();
			expect(provider.dispose).toBeUndefined();
		});
	});

	describe('subclass overriding getLastServiceHealth', () => {
		it('returns the overridden ServiceHealth value', () => {
			const provider = new HealthOverrideProvider();
			const health: ServiceHealth = {
				kind: 'reauthRequired',
				summary: 'Re-authentication needed',
				lastUpdated: new Date('2025-01-01T00:00:00Z'),
			};
			provider.setHealth(health);

			expect(provider.getLastServiceHealth()).toBe(health);
		});

		it('can return null when the subclass chooses to', () => {
			const provider = new HealthOverrideProvider();
			provider.setHealth(null);

			expect(provider.getLastServiceHealth()).toBeNull();
		});
	});
});
