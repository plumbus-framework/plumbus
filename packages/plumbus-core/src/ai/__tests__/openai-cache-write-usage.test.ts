// OpenAI prompt-cache writes: `cache_write_tokens` on Chat Completions (`prompt_tokens_details`)
// and the Responses API (`input_tokens_details`) become `TokenUsage.cacheWriteTokens`, and are
// priced as OpenAI bills them: 1.25× input from GPT-5.6 on, ordinary input before. Like cache
// reads they are part of the input tokens, so they are priced once.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { createCostTracker } from '../cost-tracker.js';
import { calculateModelCost, estimateModelCost } from '../model-pricing.js';
import { type AITool, createOpenAIAdapter } from '../provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function chatAnswer(usage: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'gpt-6-luna',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage,
    }),
  };
}

function chatStream(usage: Record<string, unknown>) {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 2,000 prompt tokens: 1,500 written to the cache, 300 read from it, 200 ordinary. */
const chatUsage = {
  prompt_tokens: 2000,
  completion_tokens: 10,
  total_tokens: 2010,
  prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 1500 },
};

describe('OpenAI cache-write tokens', () => {
  it('are read from Chat Completions usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatAnswer(chatUsage)));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' });

    const response = await adapter.complete({ prompt: 'x' });

    expect(response.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 10,
      totalTokens: 2010,
      cachedInputTokens: 300,
      cacheWriteTokens: 1500,
    });
  });

  it('are read from a Chat Completions stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatStream(chatUsage)));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' });

    const usage = [];
    for await (const event of adapter.stream({ prompt: 'x' })) {
      if (event.type === 'usage') usage.push(event.usage);
    }

    expect(usage).toEqual([
      {
        inputTokens: 2000,
        outputTokens: 10,
        totalTokens: 2010,
        cachedInputTokens: 300,
        cacheWriteTokens: 1500,
      },
    ]);
  });

  it('are read from Responses API usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'completed',
          model: 'gpt-6-luna',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          ],
          usage: {
            input_tokens: 2000,
            output_tokens: 10,
            total_tokens: 2010,
            input_tokens_details: { cached_tokens: 300, cache_write_tokens: 1500 },
          },
        }),
      }),
    );
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' });
    const tools: AITool[] = [
      { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } },
    ];

    // GPT-6 caller tools under default reasoning go to the Responses API.
    const response = await adapter.complete({ prompt: 'x', tools });

    expect(response.usage).toMatchObject({ cachedInputTokens: 300, cacheWriteTokens: 1500 });
  });

  it('stay absent when OpenAI does not report them', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          chatAnswer({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }),
        ),
    );
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' });

    const response = await adapter.complete({ prompt: 'x' });

    expect(response.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
      cachedInputTokens: 0,
    });
  });

  it('are priced at 1.25× input on GPT-6, once, in the result and on the ledger', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatAnswer(chatUsage)));
    const tracker = createCostTracker();
    const ai = createAIService(
      singleProviderConfig(createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' }), {
        defaultModel: 'gpt-6-luna',
        costTracker: tracker,
      }),
    );

    const result = await ai.generateWithUsage({ prompt: 'Say {{x}}', input: { x: 'hi' } });

    // gpt-6-luna: $0.10 input, $0.01 cached input, $0.125 cache writes, $0.50 output per MTok.
    // 200 × 0.10 + 300 × 0.01 + 1,500 × 0.125 + 10 × 0.50 = 215.5 → $0.0002155.
    expect(result.usage.cacheWriteTokens).toBe(1500);
    expect(result.cost).toBe(0.0002155);
    expect(tracker.getRecords()[0]?.cost).toBe(0.0002155);
    expect(tracker.getRecords()[0]?.usage.cacheWriteTokens).toBe(1500);
  });
});

describe('cache-write pricing by model', () => {
  it.each([
    ['gpt-6-luna', 0.000125],
    ['gpt-6-sol', 0.0025],
    ['gpt-6.1-sol', 0.0025],
    ['gpt-6-astra', 0.0125],
    ['gpt-5.6-terra', 0.0025],
    ['gpt-5.6-luna', 0.00025],
    ['gpt-5.6-cyber', 0.015625],
    ['gpt-6-luna-20260922', 0.000125],
    ['claude-sonnet-4', 0.00375],
  ])("charges %s's published cache-write rate (1.25× input)", (model, cost) => {
    expect(calculateModelCost(1000, 0, model, { cacheWriteTokens: 1000 })).toBe(cost);
  });

  it.each([
    ['gpt-5.5', 0.005],
    ['gpt-5.4-mini', 0.00075],
    ['gpt-5', 0.00125],
    ['gpt-4.1', 0.002],
    ['gpt-4o', 0.0025],
    ['o3', 0.002],
    ['gpt-rosalind-research', 0.005],
    ['chat-latest', 0.005],
  ])('charges %s nothing extra for a cache write: it costs ordinary input', (model, cost) => {
    expect(calculateModelCost(1000, 0, model, { cacheWriteTokens: 1000 })).toBe(cost);
    expect(calculateModelCost(1000, 0, model, { cacheWriteTokens: 1000 })).toBe(
      calculateModelCost(1000, 0, model),
    );
  });

  it('doubles the cache-write rate with input above the long-context threshold', () => {
    // gpt-6-luna long context: $0.25 cache writes per MTok (2 × $0.125).
    expect(estimateModelCost(300_000, 0, 'gpt-6-luna', { cacheWriteTokens: 100_000 })).toBe(
      (200_000 * 0.2 + 100_000 * 0.25) / 1_000_000,
    );
  });

  it('does not double count: writes are part of the input tokens', () => {
    // gpt-6-sol: $2 input, $2.50 cache writes per MTok.
    expect(calculateModelCost(1000, 0, 'gpt-6-sol', { cacheWriteTokens: 1000 })).toBe(0.0025);
    expect(calculateModelCost(1000, 0, 'gpt-6-sol', { cacheWriteTokens: 400 })).toBe(
      (600 * 2 + 400 * 2.5) / 1_000_000,
    );
  });
});
