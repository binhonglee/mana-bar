import { describe, it, expect } from 'vitest';
import { parseOutageTitle, buildOutageTitle } from '../../src/outage/outage-types';

describe('outage-types', () => {
    describe('parseOutageTitle', () => {
        it('should parse service and short model label', () => {
            const result = parseOutageTitle('[Outage] Claude Code - Sonnet 3.5');
            expect(result).toBeDefined();
            expect(result?.service).toBe('Claude Code');
            expect(result?.model).toBe('Sonnet 3.5');
        });

        it('should parse full model ID from title', () => {
            const result = parseOutageTitle('[Outage] Claude Code - claude-sonnet-4-6');
            expect(result).toBeDefined();
            expect(result?.service).toBe('Claude Code');
            expect(result?.model).toBe('claude-sonnet-4-6');
        });

        it('should parse versioned model ID from title', () => {
            const result = parseOutageTitle('[Outage] Claude Code - claude-sonnet-4-5-20250929');
            expect(result).toBeDefined();
            expect(result?.service).toBe('Claude Code');
            expect(result?.model).toBe('claude-sonnet-4-5-20250929');
        });

        it('should parse service without model', () => {
            const result = parseOutageTitle('[Outage] Codex');
            expect(result).toBeDefined();
            expect(result?.service).toBe('Codex');
            expect(result?.model).toBeUndefined();
        });

        it('should return null for invalid titles', () => {
            expect(parseOutageTitle('Just a regular issue')).toBeNull();
            expect(parseOutageTitle('[Bug] Claude Code - Sonnet 3.5')).toBeNull();
        });
    });

    describe('buildOutageTitle', () => {
        it('should build title with service and short model label', () => {
            expect(buildOutageTitle('Claude Code', 'Opus')).toBe('[Outage] Claude Code - Opus');
        });

        it('should build title with service and full model ID', () => {
            expect(buildOutageTitle('Claude Code', 'claude-sonnet-4-6')).toBe('[Outage] Claude Code - claude-sonnet-4-6');
        });

        it('should build title with service only', () => {
            expect(buildOutageTitle('Codex')).toBe('[Outage] Codex');
        });

        it('buildOutageTitle output should be parseable by parseOutageTitle', () => {
            const modelId = 'claude-sonnet-4-6';
            const title = buildOutageTitle('Claude Code', modelId);
            const parsed = parseOutageTitle(title);

            expect(parsed?.service).toBe('Claude Code');
            expect(parsed?.model).toBe(modelId);
        });
    });
});
