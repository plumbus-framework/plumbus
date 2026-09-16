import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAIService, singleProviderConfig, type AIProviderSpan } from '../ai-service.js';
import { createOpenAIAdapter, type AIProviderAdapter } from '../provider.js';

const response = {
  content: 'ok',
  model: 'mock-model',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: 'stop',
};

function mockProvider(overrides: Partial<AIProviderAdapter> = {}): AIProviderAdapter {
  return {
    name: 'mock',
    complete: async () => response,
    async *stream() {
      yield { type: 'done', finishReason: 'stop' };
    },
    embed: async (request) => ({
      embeddings: request.texts.map(() => [0]),
      model: 'mock-embed',
      usage: { totalTokens: 1 },
    }),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('AI provider admission and observability', () => {
  it('refuses saturation immediately per tenant/provider/package while preserving other scopes', async () => {
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const complete = vi
      .fn()
      .mockImplementationOnce(async () => {
        await held;
        return response;
      })
      .mockResolvedValue(response);
    const base = createAIService(
      singleProviderConfig(mockProvider({ complete }), {
        providerConcurrency: { maxConcurrentCalls: 1 },
      }),
    );
    const tenantA = base.withContext?.({ tenantId: 'tenant-a', correlationId: 'a'.repeat(32) });
    const tenantB = base.withContext?.({ tenantId: 'tenant-b', correlationId: 'b'.repeat(32) });
    if (!tenantA || !tenantB) throw new Error('withContext is required');

    const first = tenantA.generate({
      prompt: 'one',
      input: {},
      costContext: { serviceArea: 'document-processing' },
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    await expect(
      tenantA.generate({
        prompt: 'two',
        input: {},
        costContext: { serviceArea: 'document-processing' },
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      metadata: {
        failureCode: 'ai-provider-concurrency-exhausted',
        retryAfterSeconds: 1,
      },
    });

    // A different package service area and a different tenant each retain an independent slot.
    await expect(
      tenantA.generate({
        prompt: 'other-package',
        input: {},
        costContext: { serviceArea: 'document-analysis' },
      }),
    ).resolves.toBe('ok');
    await expect(
      tenantB.generate({
        prompt: 'other-tenant',
        input: {},
        costContext: { serviceArea: 'document-processing' },
      }),
    ).resolves.toBe('ok');

    releaseFirst();
    await expect(first).resolves.toBe('ok');
    await expect(
      tenantA.generate({
        prompt: 'after-release',
        input: {},
        costContext: { serviceArea: 'document-processing' },
      }),
    ).resolves.toBe('ok');
  });

  it('sends trusted trace headers to the adapter and exports a privacy-safe provider span', async () => {
    const requests: Array<Record<string, string> | undefined> = [];
    const spans: AIProviderSpan[] = [];
    const provider = mockProvider({
      complete: vi.fn(async (request) => {
        requests.push(request.transportHeaders as Record<string, string> | undefined);
        return response;
      }),
    });
    const service = createAIService(
      singleProviderConfig(provider, {
        resolveProviderHeaders: (context) => ({
          traceparent: `00-${context.correlationId}-${'2'.repeat(16)}-01`,
        }),
        onProviderSpan: (span) => {
          spans.push(span);
        },
      }),
    ).withContext?.({
      tenantId: 'tenant-private',
      actor: 'actor-private',
      correlationId: '1'.repeat(32),
    });
    if (!service) throw new Error('withContext is required');

    await service.generate({
      prompt: 'trace me',
      input: {},
      costContext: { serviceArea: 'document-processing' },
    });

    expect(requests).toEqual([{ traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` }]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      provider: 'mock',
      operation: 'generate',
      status: 'ok',
      correlationId: '1'.repeat(32),
      traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
    });
  });

  it('puts traceparent on the built-in provider HTTP request, not only on custom adapters', async () => {
    const fetchCall = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            model: 'gpt-test',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchCall);
    const traceparent = `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`;
    const service = createAIService(
      singleProviderConfig(
        createOpenAIAdapter({
          apiKey: 'provider-secret',
          baseUrl: 'https://provider.invalid/v1',
          model: 'gpt-test',
        }),
        {
          resolveProviderHeaders: () => ({ traceparent }),
        },
      ),
    );

    await service.generate({ prompt: 'trace me', input: {} });
    expect(fetchCall).toHaveBeenCalledTimes(1);
    const init = fetchCall.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ traceparent });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer provider-secret' });
  });
});
