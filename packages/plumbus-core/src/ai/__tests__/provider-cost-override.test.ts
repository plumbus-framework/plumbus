import { describe, expect, it } from 'vitest';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import type { AIProviderAdapter, ProviderResponse, ProviderStreamEvent } from '../provider.js';

function mockProvider(overrides: Partial<AIProviderAdapter> = {}): AIProviderAdapter {
  return {
    name: 'custom',
    async complete(): Promise<ProviderResponse> {
      return {
        content: '{"ok":true}',
        model: 'custom-model',
        usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
        finishReason: 'stop',
        cost: 1.23,
      };
    },
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'content_delta', delta: 'hi' };
      yield {
        type: 'done',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        finishReason: 'stop',
        cost: 4.56,
      };
    },
    async embed() {
      return {
        embeddings: [[0]],
        model: 'embed',
        usage: { totalTokens: 1 },
        cost: 0.01,
      };
    },
    ...overrides,
  };
}

describe('provider-supplied cost', () => {
  it('generateWithUsage prefers ProviderResponse.cost over catalog', async () => {
    const service = createAIService(singleProviderConfig(mockProvider()));
    const result = await service.generateWithUsage({
      prompt: 'say hi',
      input: {},
      outputValidation: 'none',
    });
    expect(result.cost).toBe(1.23);
  });

  it('streamGenerate prefers done.cost over catalog', async () => {
    const service = createAIService(singleProviderConfig(mockProvider()));
    let finalCost: number | undefined;
    for await (const ev of service.streamGenerate({ prompt: 'x', input: {} })) {
      if (ev.type === 'done') finalCost = ev.cost;
    }
    expect(finalCost).toBe(4.56);
  });

  it('falls back to calculateModelCost when cost omitted', async () => {
    const provider = mockProvider({
      name: 'openai',
      async complete(): Promise<ProviderResponse> {
        return {
          content: 'plain',
          model: 'gpt-4o-mini',
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
          finishReason: 'stop',
        };
      },
    });
    const service = createAIService({
      ...singleProviderConfig(provider),
      defaultModel: 'gpt-4o-mini',
    });
    const result = await service.generateWithUsage({
      prompt: 'x',
      input: {},
      outputValidation: 'none',
    });
    // gpt-4o-mini catalog: 0.15/0.6 per MTok → 1000*0.15 + 500*0.6 = 0.00015+0.0003 = 0.00045
    expect(result.cost).toBe(0.00045);
  });
});
