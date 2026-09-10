import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCostTracker } from '../cost-tracker.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import type { AIProviderAdapter, ProviderResponse, ProviderStreamEvent } from '../provider.js';

afterEach(() => vi.useRealTimers());

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

describe('recorded spend and budget enforcement', () => {
  it.each([
    'generate',
    'stream',
    'extract',
    'classify',
  ] as const)('records %s provider cost and blocks the next call at the daily limit', async (operation) => {
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    const hook = vi.fn();
    const provider = mockProvider({
      async complete() {
        return {
          content: operation === 'classify' ? '["ok"]' : '{"ok":true}',
          model: 'custom-model',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          cost: 1.23,
          finishReason: 'stop',
        };
      },
    });
    const service = createAIService(
      singleProviderConfig(provider, { costTracker: tracker, onAICostRecorded: hook }),
    );
    const run = async () => {
      if (operation === 'stream') {
        for await (const event of service.streamGenerate({ prompt: 'x', input: {} })) {
          expect(event.type).toBeDefined();
        }
      } else if (operation === 'extract') {
        await service.extract({ text: 'x', schema: z.object({ ok: z.boolean() }) });
      } else if (operation === 'classify') {
        await service.classify({ text: 'x', labels: ['ok'] });
      } else {
        await service.generate({ prompt: 'x', input: {} });
      }
    };
    await run();
    expect(tracker.getDailyUsage().totalCost).toBe(operation === 'stream' ? 4.56 : 1.23);
    expect(hook.mock.calls[0]?.[0].cost).toBe(tracker.getDailyUsage().totalCost);
    await expect(run()).rejects.toThrow('AI budget exceeded');
    expect(tracker.getRecords()).toHaveLength(1);
  });

  it('allows free providers with a dollar budget and unpriced local providers without one', async () => {
    for (const cost of [0, undefined]) {
      const tracker = createCostTracker(cost === 0 ? { dailyCostLimit: 1 } : undefined);
      const provider = mockProvider({
        async complete() {
          return {
            content: 'local answer',
            model: 'local',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost,
            finishReason: 'stop',
          };
        },
      });
      const service = createAIService(singleProviderConfig(provider, { costTracker: tracker }));
      await service.generate({ prompt: 'x', input: {} });
      await service.generate({ prompt: 'x', input: {} });
      expect(tracker.getRecords()[0]?.cost).toBe(cost ?? null);
    }
  });

  it('checks token estimates before contacting the provider', async () => {
    const complete = vi.fn(mockProvider().complete);
    const service = createAIService(
      singleProviderConfig(mockProvider({ complete }), {
        costTracker: createCostTracker({ maxTokensPerRequest: 10 }),
      }),
    );
    await expect(service.generate({ prompt: 'x'.repeat(1000), input: {} })).rejects.toThrow(
      'AI budget exceeded',
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

it('does not treat a stream without usage or pricing as free', async () => {
  const tracker = createCostTracker({ dailyCostLimit: 1 });
  const service = createAIService(
    singleProviderConfig(
      mockProvider({
        async *stream() {
          yield { type: 'content_delta', delta: 'ok' };
          yield { type: 'done' };
        },
      }),
      { defaultModel: 'gpt-4o-mini', costTracker: tracker },
    ),
  );
  for await (const event of service.streamGenerate({ prompt: 'x', input: {} }))
    expect(event.type).toBeDefined();
  expect(tracker.getRecords()[0]?.cost).toBeNull();
  expect(tracker.checkBudget({}).allowed).toBe(false);
});

it.each([
  ['2026-11-21T23:59:59.999Z', 1.81],
  ['2026-11-22T00:00:00.000Z', 2.27],
])('uses Sol alias pricing consistently in results and the budget ledger at %s', async (at, expectedCost) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  const tracker = createCostTracker({ dailyCostLimit: 1 });
  const service = createAIService(
    singleProviderConfig(
      mockProvider({
        async complete() {
          return {
            content: 'answer',
            model: 'gpt-5.6-sol',
            finishReason: 'stop',
            usage: {
              inputTokens: 300_000,
              outputTokens: 1000,
              totalTokens: 301_000,
              cachedInputTokens: 100_000,
              cacheWriteTokens: 50_000,
            },
          };
        },
      }),
      { defaultModel: 'gpt-5.6', costTracker: tracker },
    ),
  );
  const result = await service.generateWithUsage({ prompt: 'x', input: {} });
  expect(result.cost).toBe(expectedCost);
  expect(tracker.getRecords()[0]?.cost).toBe(expectedCost);
  await expect(service.generate({ prompt: 'x', input: {} })).rejects.toThrow('AI budget exceeded');
});

it.each([
  ['2026-11-21T23:59:59.999Z', 0.014],
  ['2026-11-22T00:00:00.000Z', 0.02],
])('uses the same static Sol rate for stream results and ledger rows at %s', async (at, expectedCost) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  const tracker = createCostTracker();
  const service = createAIService(
    singleProviderConfig(
      mockProvider({
        async *stream() {
          yield { type: 'content_delta', delta: 'answer' };
          yield {
            type: 'done',
            finishReason: 'stop',
            usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
          };
        },
      }),
      { defaultModel: 'gpt-5.6', costTracker: tracker },
    ),
  );
  let resultCost: number | undefined;
  for await (const event of service.streamGenerate({ prompt: 'x', input: {} })) {
    if (event.type === 'done') resultCost = event.cost;
  }
  expect(resultCost).toBe(expectedCost);
  expect(tracker.getRecords()[0]?.cost).toBe(expectedCost);
});

it('keeps legacy numeric results without counting unknown cost as free in budgets', async () => {
  const tracker = createCostTracker({ dailyCostLimit: 1 });
  const provider = mockProvider({
    async complete() {
      return {
        content: 'local',
        model: 'unpriced',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  });
  const service = createAIService(singleProviderConfig(provider, { costTracker: tracker }));
  const result = await service.generateWithUsage({ prompt: 'hello', input: {} });
  expect(result).toMatchObject({ cost: 0, costAvailable: false });
  expect(tracker.getRecords()[0]?.cost).toBeNull();
  await expect(service.generate({ prompt: 'again', input: {} })).rejects.toThrow(
    'AI budget exceeded',
  );
});
