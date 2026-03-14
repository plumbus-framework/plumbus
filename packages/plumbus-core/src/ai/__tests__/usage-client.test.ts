import { describe, expect, it, vi } from 'vitest';
import { createUsageAPIClient, UsageAPIError } from '../usage-client.js';

describe('Usage API Client', () => {
  describe('createUsageAPIClient', () => {
    it('creates an OpenAI client', () => {
      const client = createUsageAPIClient({
        provider: 'openai',
        apiKey: 'sk-test',
      });
      expect(client.provider).toBe('openai');
    });

    it('creates an Anthropic client', () => {
      const client = createUsageAPIClient({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
      });
      expect(client.provider).toBe('anthropic');
    });

    it('throws for unsupported provider', () => {
      expect(() =>
        createUsageAPIClient({
          provider: 'unknown' as 'openai',
          apiKey: 'test',
        }),
      ).toThrow('Unsupported usage API provider');
    });
  });

  describe('OpenAI Usage Client', () => {
    it('calls the correct endpoint with auth header', async () => {
      const mockResponse = {
        data: [
          {
            results: [
              {
                model: 'gpt-4o',
                input_tokens: 1000,
                output_tokens: 500,
                num_model_requests: 5,
                amount: { value: 0.0075, currency: 'usd' },
              },
            ],
          },
        ],
      };

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

      const client = createUsageAPIClient({
        provider: 'openai',
        apiKey: 'sk-test-key',
      });

      const start = new Date('2024-01-01');
      const end = new Date('2024-01-02');
      const result = await client.fetchUsage({ startDate: start, endDate: end });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('/v1/organization/usage/completions');
      expect((options as RequestInit).headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer sk-test-key' }),
      );

      expect(result.totalCost).toBe(0.0075);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.model).toBe('gpt-4o');
      expect(result.entries[0]?.requestCount).toBe(5);

      fetchSpy.mockRestore();
    });

    it('throws UsageAPIError on non-OK response', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
        );

      const client = createUsageAPIClient({
        provider: 'openai',
        apiKey: 'bad-key',
      });

      await expect(
        client.fetchUsage({ startDate: new Date(), endDate: new Date() }),
      ).rejects.toThrow(UsageAPIError);

      fetchSpy.mockRestore();
    });
  });

  describe('Anthropic Usage Client', () => {
    it('calls the correct endpoint with x-api-key header', async () => {
      const mockResponse = {
        data: [
          {
            model: 'claude-sonnet-4-20250514',
            input_tokens: 2000,
            output_tokens: 1000,
            num_requests: 3,
            cost_usd: 0.021,
          },
        ],
      };

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

      const client = createUsageAPIClient({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
      });

      const start = new Date('2024-01-01');
      const end = new Date('2024-01-02');
      const result = await client.fetchUsage({ startDate: start, endDate: end });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('/v1/usage');
      expect((options as RequestInit).headers).toEqual(
        expect.objectContaining({ 'x-api-key': 'sk-ant-test' }),
      );

      expect(result.totalCost).toBe(0.021);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.model).toBe('claude-sonnet-4-20250514');

      fetchSpy.mockRestore();
    });

    it('throws UsageAPIError on non-OK response', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));

      const client = createUsageAPIClient({
        provider: 'anthropic',
        apiKey: 'bad-key',
      });

      await expect(
        client.fetchUsage({ startDate: new Date(), endDate: new Date() }),
      ).rejects.toThrow(UsageAPIError);

      fetchSpy.mockRestore();
    });
  });
});
