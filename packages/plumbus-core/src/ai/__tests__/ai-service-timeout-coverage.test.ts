// Per-call `timeoutMs` beyond generate/streamGenerate: extract, classify (text and decision
// providers), embeddings (adapter, RAG pipeline, ai.retrieve) and runToolLoop.
import type { DecisionProviderAdapter, DecisionRequest } from '@plumbus/ai-decision/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  AIGenerateWithUsageConfig,
  AIService,
  AIToolEnabledGenerateResult,
} from '../../types/context.js';
import { type AIServiceConfig, createAIService } from '../ai-service.js';
import {
  type AIProviderAdapter,
  createOpenAIAdapter,
  type EmbeddingRequest,
  isProviderAPIError,
  isProviderTimeoutError,
  type ProviderRequest,
} from '../provider.js';
import { createInMemoryVectorStore, createRAGPipeline } from '../rag/index.js';
import { AIInvalidRequestError } from '../refusal.js';
import { runToolLoop } from '../tool-loop.js';

const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

/** A provider that records every completion and embedding request and answers it. */
function recordingProvider(answers: string[] = []) {
  const requests: ProviderRequest[] = [];
  const embeds: EmbeddingRequest[] = [];
  const provider: AIProviderAdapter = {
    name: 'openai',
    async complete(request) {
      requests.push(request);
      const fallback = request.system?.startsWith('Classify') ? '["billing"]' : '{"name":"Ada"}';
      return { content: answers.shift() ?? fallback, model: 'gpt-4o', usage, finishReason: 'stop' };
    },
    async *stream() {
      yield { type: 'done', usage };
    },
    async embed(request) {
      embeds.push(request);
      return {
        embeddings: request.texts.map(() => [1, 0]),
        model: 'text-embedding-3-small',
        usage: { totalTokens: 1 },
      };
    },
  };
  return { provider, requests, embeds };
}

function service(provider: AIProviderAdapter, extra: Partial<AIServiceConfig> = {}) {
  return createAIService({
    ...extra,
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
  });
}

const person = z.object({ name: z.string() });

describe('extract: per-call timeoutMs', () => {
  it('sends it as the provider request timeout, on every validation retry', async () => {
    const { provider, requests } = recordingProvider(['{"name":1}', '{"name":"Ada"}']);
    await service(provider).extract({ schema: person, text: 'Ada', timeoutMs: 6_000 });
    expect(requests.map((request) => request.timeout)).toEqual([6_000, 6_000]);
  });

  it("keeps the adapter's requestTimeout when unset", async () => {
    const { provider, requests } = recordingProvider();
    await service(provider).extract({ schema: person, text: 'Ada' });
    expect(requests[0]).not.toHaveProperty('timeout');
  });
});

describe('classify: per-call timeoutMs', () => {
  it('sends it as the text provider request timeout', async () => {
    const { provider, requests } = recordingProvider();
    const labels = await service(provider).classify({
      labels: ['billing', 'refund'],
      text: 'charge',
      timeoutMs: 7_000,
    });
    expect(labels).toEqual(['billing']);
    expect(requests.map((request) => request.timeout)).toEqual([7_000]);
  });

  it('passes it to a decision provider as its timeoutMs', async () => {
    const { provider } = recordingProvider();
    const seen: DecisionRequest[] = [];
    const native = {
      name: 'native',
      async decide(request: DecisionRequest) {
        seen.push(request);
        return {
          provider: 'native',
          model: 'native-model',
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          cost: null,
          costAvailable: false,
          latencyMs: 1,
          answers: { label_0: { type: 'probability', probability: 0.9 } },
        };
      },
    } as DecisionProviderAdapter;
    const ai = service(provider, {
      decisions: { providers: { native }, defaultProvider: 'native' },
    });
    await ai.classify({
      labels: ['billing'],
      text: 'charge',
      provider: 'native',
      timeoutMs: 8_000,
    });
    expect(seen.map((request) => request.timeoutMs)).toEqual([8_000]);
  });
});

describe.each([0, 1.5, Number.NaN, 2 ** 31])('a per-call timeoutMs of %s', (timeoutMs) => {
  it('is refused by extract and classify before the provider is called', async () => {
    const { provider, requests } = recordingProvider();
    const ai = service(provider);
    await expect(ai.extract({ schema: person, text: 'Ada', timeoutMs })).rejects.toBeInstanceOf(
      AIInvalidRequestError,
    );
    await expect(
      ai.classify({ labels: ['billing'], text: 'charge', timeoutMs }),
    ).rejects.toBeInstanceOf(AIInvalidRequestError);
    expect(requests).toHaveLength(0);
  });

  it('is refused by retrieve before the query is embedded', async () => {
    const { provider, embeds } = recordingProvider();
    const ragPipeline = createRAGPipeline({ provider, vectorStore: createInMemoryVectorStore() });
    const ai = service(provider, { ragPipeline });
    await expect(ai.retrieve({ query: 'q', timeoutMs })).rejects.toBeInstanceOf(
      AIInvalidRequestError,
    );
    expect(embeds).toHaveLength(0);
  });

  it('is refused by RAG ingest and retrieve before anything is embedded, whatever the adapter', async () => {
    // An adapter that never checks `timeout` itself, as third-party adapters may not.
    const { provider, embeds } = recordingProvider();
    const vectorStore = createInMemoryVectorStore();
    const ragPipeline = createRAGPipeline({ provider, vectorStore });
    await expect(
      ragPipeline.ingest({ documentId: 'd', content: 'text', source: 's', timeoutMs }),
    ).rejects.toMatchObject({ name: 'AIInvalidRequestError', reason: 'timeout_invalid' });
    await expect(ragPipeline.retrieve({ query: 'q', timeoutMs })).rejects.toMatchObject({
      name: 'AIInvalidRequestError',
      reason: 'timeout_invalid',
    });
    expect(embeds).toHaveLength(0);
  });
});

describe('embeddings: per-call timeout', () => {
  it('reaches the adapter from RAG ingest, RAG retrieve and ai.retrieve', async () => {
    const { provider, embeds } = recordingProvider();
    const ragPipeline = createRAGPipeline({ provider, vectorStore: createInMemoryVectorStore() });
    await ragPipeline.ingest({ documentId: 'd', content: 'text', source: 's', timeoutMs: 4_000 });
    await ragPipeline.retrieve({ query: 'q', timeoutMs: 3_000 });
    await service(provider, { ragPipeline }).retrieve({
      query: 'q',
      timeoutMs: 2_000,
    });
    await ragPipeline.retrieve({ query: 'q' });
    expect(embeds.map((request) => request.timeout)).toEqual([4_000, 3_000, 2_000, undefined]);
    expect(embeds[3]).not.toHaveProperty('timeout');
  });

  describe('the OpenAI adapter', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('ends an embedding request at its timeout, as a timeout ProviderAPIError', async () => {
      // An endpoint that takes the request and never answers until it is aborted.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        ),
      );
      const adapter = createOpenAIAdapter({
        apiKey: 'sk-test',
        baseUrl: 'http://openai.invalid/v1',
      });
      const startedAt = Date.now();
      const error = await adapter.embed({ texts: ['a'], timeout: 50 }).catch((e: unknown) => e);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(isProviderTimeoutError(error)).toBe(true);
      expect(error).toMatchObject({
        providerName: 'openai',
        retryable: false,
        timeoutMs: 50,
        message: 'OpenAI Embedding API request timed out after 50 ms',
      });
    });

    it('refuses an unusable embedding timeout before sending', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const adapter = createOpenAIAdapter({
        apiKey: 'sk-test',
        baseUrl: 'http://openai.invalid/v1',
      });
      await expect(adapter.embed({ texts: ['a'], timeout: 0 })).rejects.toBeInstanceOf(
        AIInvalidRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe('runToolLoop: per-call timeoutMs', () => {
  it('passes it to every round and to the final request after the rounds run out', async () => {
    const configs: AIGenerateWithUsageConfig[] = [];
    const toolRound: AIToolEnabledGenerateResult = {
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'lookup', argumentsStatus: 'parsed', arguments: {} }],
      usage,
      model: 'm',
      provider: 'p',
      cost: 0,
    };
    const ai = {
      generateWithUsage: vi.fn(async (config: AIGenerateWithUsageConfig) => {
        configs.push(config);
        return 'tools' in config ? toolRound : { ...toolRound, finishReason: 'stop', data: {} };
      }),
    } as unknown as AIService;
    await runToolLoop(ai, {
      prompt: 'agent',
      input: {},
      tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
      execute: async () => 'ok',
      maxRounds: 2,
      timeoutMs: 9_000,
    });
    expect(configs.map((config) => config.timeoutMs)).toEqual([9_000, 9_000, 9_000]);
  });
});

describe('isProviderTimeoutError', () => {
  it('tells a timeout from other provider failures, whichever adapter built it', () => {
    const bedrockShaped = Object.assign(new Error('Bedrock request timed out after 100 ms'), {
      name: 'ProviderAPIError',
      providerName: 'bedrock',
      retryable: false,
      attempts: 1,
      timeoutMs: 100,
    });
    const rateLimited = Object.assign(new Error('OpenAI API error (429): slow down'), {
      name: 'ProviderAPIError',
      providerName: 'openai',
      retryable: true,
      attempts: 3,
      statusCode: 429,
    });
    expect(isProviderTimeoutError(bedrockShaped)).toBe(true);
    expect(isProviderAPIError(rateLimited)).toBe(true);
    expect(isProviderTimeoutError(rateLimited)).toBe(false);
    expect(isProviderTimeoutError(new Error('timeout'))).toBe(false);
    expect(isProviderTimeoutError(undefined)).toBe(false);
  });
});
