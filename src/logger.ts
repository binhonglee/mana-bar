let debugLoggingEnabled = false;

export function setDebugLoggingEnabled(enabled: boolean): void {
	debugLoggingEnabled = enabled;
}

export function isDebugLoggingEnabled(): boolean {
	return debugLoggingEnabled;
}

export function debugLog(message?: unknown, ...optionalParams: unknown[]): void {
	if (!debugLoggingEnabled) {
		return;
	}
	console.log(message, ...optionalParams);
}

export function debugWarn(message?: unknown, ...optionalParams: unknown[]): void {
	if (!debugLoggingEnabled) {
		return;
	}
	console.warn(message, ...optionalParams);
}

export function debugError(message?: unknown, ...optionalParams: unknown[]): void {
	if (!debugLoggingEnabled) {
		return;
	}
	console.error(message, ...optionalParams);
}
