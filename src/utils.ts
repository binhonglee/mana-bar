import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Safely read a JSON file
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(content) as T;
	} catch (error) {
		return null;
	}
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get home directory path
 */
export function getHomeDir(): string {
	return os.homedir();
}

/**
 * Join paths safely
 */
export function joinPath(...paths: string[]): string {
	return path.join(...paths);
}

/**
 * Format time until reset (e.g., "2h 15m", "45m", "Just now")
 */
export function formatTimeUntilReset(resetTime: Date): string {
	const now = new Date();
	const diff = resetTime.getTime() - now.getTime();

	if (diff <= 0) {
		return 'Just now';
	}

	const hours = Math.floor(diff / (1000 * 60 * 60));
	const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}
