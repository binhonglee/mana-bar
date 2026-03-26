import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	debugError,
	debugLog,
	debugWarn,
	isDebugLoggingEnabled,
	setDebugLoggingEnabled,
} from '../../src/logger';

describe('logger', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		setDebugLoggingEnabled(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setDebugLoggingEnabled(false);
	});

	describe('setDebugLoggingEnabled / isDebugLoggingEnabled', () => {
		it('starts with debug logging disabled', () => {
			expect(isDebugLoggingEnabled()).toBe(false);
		});

		it('enables debug logging', () => {
			setDebugLoggingEnabled(true);
			expect(isDebugLoggingEnabled()).toBe(true);
		});

		it('disables debug logging', () => {
			setDebugLoggingEnabled(true);
			setDebugLoggingEnabled(false);
			expect(isDebugLoggingEnabled()).toBe(false);
		});

		it('can toggle state multiple times', () => {
			setDebugLoggingEnabled(true);
			expect(isDebugLoggingEnabled()).toBe(true);

			setDebugLoggingEnabled(false);
			expect(isDebugLoggingEnabled()).toBe(false);

			setDebugLoggingEnabled(true);
			expect(isDebugLoggingEnabled()).toBe(true);
		});
	});

	describe('debugLog', () => {
		it('does not log when debug is disabled', () => {
			setDebugLoggingEnabled(false);
			debugLog('test message');

			expect(console.log).not.toHaveBeenCalled();
		});

		it('logs when debug is enabled', () => {
			setDebugLoggingEnabled(true);
			debugLog('test message');

			expect(console.log).toHaveBeenCalledWith('test message');
		});

		it('logs with multiple parameters', () => {
			setDebugLoggingEnabled(true);
			debugLog('message', 'param1', { key: 'value' }, 123);

			expect(console.log).toHaveBeenCalledWith('message', 'param1', { key: 'value' }, 123);
		});

		it('handles undefined message', () => {
			setDebugLoggingEnabled(true);
			debugLog(undefined);

			expect(console.log).toHaveBeenCalledWith(undefined);
		});
	});

	describe('debugWarn', () => {
		it('does not warn when debug is disabled', () => {
			setDebugLoggingEnabled(false);
			debugWarn('warning message');

			expect(console.warn).not.toHaveBeenCalled();
		});

		it('warns when debug is enabled', () => {
			setDebugLoggingEnabled(true);
			debugWarn('warning message');

			expect(console.warn).toHaveBeenCalledWith('warning message');
		});

		it('warns with multiple parameters', () => {
			setDebugLoggingEnabled(true);
			debugWarn('warning', { details: 'info' });

			expect(console.warn).toHaveBeenCalledWith('warning', { details: 'info' });
		});
	});

	describe('debugError', () => {
		it('does not error when debug is disabled', () => {
			setDebugLoggingEnabled(false);
			debugError('error message');

			expect(console.error).not.toHaveBeenCalled();
		});

		it('errors when debug is enabled', () => {
			setDebugLoggingEnabled(true);
			debugError('error message');

			expect(console.error).toHaveBeenCalledWith('error message');
		});

		it('errors with Error objects', () => {
			setDebugLoggingEnabled(true);
			const error = new Error('test error');
			debugError('error occurred', error);

			expect(console.error).toHaveBeenCalledWith('error occurred', error);
		});
	});

	describe('state isolation', () => {
		it('logging functions respect current state', () => {
			setDebugLoggingEnabled(true);
			debugLog('should log');
			expect(console.log).toHaveBeenCalledTimes(1);

			setDebugLoggingEnabled(false);
			debugLog('should not log');
			expect(console.log).toHaveBeenCalledTimes(1);

			setDebugLoggingEnabled(true);
			debugLog('should log again');
			expect(console.log).toHaveBeenCalledTimes(2);
		});
	});
});
