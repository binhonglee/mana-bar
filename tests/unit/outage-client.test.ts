import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutageClient } from '../../src/outage/outage-client';
import * as https from 'https';
import { EventEmitter } from 'events';

// Mock the https module
vi.mock('https');

describe('OutageClient', () => {
    let client: OutageClient;

    beforeEach(() => {
        // Reset mocks and create a new client with a shorter TTL for testing
        vi.resetAllMocks();
        client = new OutageClient(100); 
    });

    /**
     * Helper to mock an HTTP response
     */
    function mockHttpResponse(statusCode: number, data: any) {
        const mockReq = new EventEmitter() as any;
        mockReq.end = vi.fn();
        
        const mockRes = new EventEmitter() as any;
        mockRes.statusCode = statusCode;
        
        (https.request as any).mockImplementation((options: any, callback: any) => {
            callback(mockRes);
            mockRes.emit('data', JSON.stringify(data));
            mockRes.emit('end');
            return mockReq;
        });
    }

    it('should fetch and parse open issues successfully', async () => {
        const mockIssues = [
            {
                number: 1,
                title: '[Outage] Claude Code - Sonnet',
                html_url: 'https://github.com/binhonglee/mana-bar-status/issues/1',
                created_at: '2023-10-27T10:00:00Z',
                labels: [{ name: 'outage' }, { name: 'verified' }],
                reactions: { '+1': 5 }
            },
            {
                number: 2,
                title: '[Outage] Codex',
                html_url: 'https://github.com/binhonglee/mana-bar-status/issues/2',
                created_at: '2023-10-27T11:00:00Z',
                labels: [{ name: 'outage' }] // Unverified
            },
            {
                number: 3,
                title: 'Some random issue', // Should be ignored
                html_url: 'https://github.com/binhonglee/mana-bar-status/issues/3',
                created_at: '2023-10-27T12:00:00Z',
                labels: []
            }
        ];

        mockHttpResponse(200, mockIssues);

        const status = await client.getOutageStatus();
        
        expect(status.reports.length).toBe(2);
        
        expect(status.reports[0].service).toBe('Claude Code');
        expect(status.reports[0].model).toBe('Sonnet');
        expect(status.reports[0].verified).toBe(true);
        expect(status.reports[0].reactionCount).toBe(5);

        expect(status.reports[1].service).toBe('Codex');
        expect(status.reports[1].model).toBeUndefined();
        expect(status.reports[1].verified).toBe(false);
        expect(status.reports[1].reactionCount).toBe(0);
    });

    it('should return empty reports on API error', async () => {
        mockHttpResponse(500, { message: 'Internal Server Error' });
        
        const status = await client.getOutageStatus();
        expect(status.reports.length).toBe(0);
    });

    it('should cache results and deduplicate fetches', async () => {
        mockHttpResponse(200, []);
        
        const p1 = client.getOutageStatus();
        const p2 = client.getOutageStatus();
        
        await Promise.all([p1, p2]);
        
        // request should only be called once due to concurrent fetch deduplication
        expect(https.request).toHaveBeenCalledTimes(1);

        // Call again immediately, should use cache
        await client.getOutageStatus();
        expect(https.request).toHaveBeenCalledTimes(1);
    });

    it('should bypass cache on refresh', async () => {
        mockHttpResponse(200, []);
        
        await client.getOutageStatus();
        expect(https.request).toHaveBeenCalledTimes(1);

        await client.refresh();
        expect(https.request).toHaveBeenCalledTimes(2);
    });
});
