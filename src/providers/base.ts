import { ServiceId, UsageData } from '../types';

/**
 * Abstract base class for usage providers
 */
export abstract class UsageProvider {
	abstract readonly serviceId: ServiceId;

	/**
	 * Get the service name (e.g., "Claude Code", "Codex")
	 */
	abstract getServiceName(): string;

	/**
	 * Check if the service is available (installed/configured)
	 */
	abstract isAvailable(): Promise<boolean>;

	/**
	 * Get current usage data
	 * @returns UsageData or null if unavailable
	 */
	abstract getUsage(): Promise<UsageData | null>;

	/**
	 * Get list of available models for this service
	 * @returns Array of model names, or empty array if not applicable
	 */
	abstract getModels(): Promise<string[]>;

	/**
	 * Clean up resources (optional)
	 * Override this if the provider needs to clean up processes, connections, etc.
	 */
	dispose?(): void;
}
