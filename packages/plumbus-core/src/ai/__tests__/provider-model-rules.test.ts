import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicAdapter, createOpenAIAdapter } from '../provider.js';

// Per-model request and usage rules in the built-in adapters. Kept out of
// provider.test.ts, which other suites import for its mock provider.

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(mockFetch: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[call]?.[1].body);
}

describe('OpenAI GPT-5.6 and GPT-6 rules', () => {
  it.each([
    ['gpt-6-astra', { mode: 'disabled' }, 'reasoning_disabled_unsupported'],
    ['gpt-6.1-sol-2026-10-01', { mode: 'disabled' }, 'reasoning_disabled_unsupported'],
    ['gpt-6-luna', { mode: 'effort', effort: 'minimal' }, 'reasoning_effort_unsupported'],
  ] as const)('rejects %s reasoning %j before I/O', async (model, reasoning, reason) => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model });
    await expect(adapter.complete({ prompt: 'Say hello', reasoning })).rejects.toMatchObject({
      name: 'AIInvalidRequestError',
      reason,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports cache writes for GPT-5.6 and later only', async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 5,
      total_tokens: 1005,
      prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
          model: 'test-model',
          usage,
        }),
      })),
    );

    const base = { inputTokens: 1000, outputTokens: 5, totalTokens: 1005, cachedInputTokens: 200 };
    for (const model of ['gpt-6.1-sol', 'gpt-5.6-terra']) {
      const result = await createOpenAIAdapter({ apiKey: 'sk-test', model }).complete({
        prompt: 'Say hello',
      });
      expect(result.usage, model).toEqual({ ...base, cacheWriteTokens: 300 });
    }
    const earlier = await createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-5.5' }).complete({
      prompt: 'Say hello',
    });
    expect(earlier.usage).toEqual(base);
  });

  it('reports GPT-6 cache writes on the streaming usage chunk', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop","index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5,"total_tokens":1005,"prompt_tokens_details":{"cached_tokens":200,"cache_write_tokens":300}}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        ),
    );

    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-6-luna' });
    const events = [];
    for await (const event of adapter.stream({ prompt: 'Stream hello' })) events.push(event);

    expect(events.find((event) => event.type === 'usage')?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 5,
      totalTokens: 1005,
      cachedInputTokens: 200,
      cacheWriteTokens: 300,
    });
  });
});

describe('Anthropic fixed-sampling models', () => {
  function stubAnthropic() {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-test',
        usage: { input_tokens: 10, output_tokens: 8 },
        stop_reason: 'end_turn',
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  // One row per fixed-sampling model, plus a platform-prefixed id and two suffixed ids:
  // the `thinking` type sent for disabled reasoning (null when the model rejects it) and
  // whether `budget_tokens` is accepted, per Anthropic's thinking-troubleshooting table.
  it.each([
    ['claude-fable-5-1', null, false],
    ['claude-mythos-5-1', null, false],
    ['claude-fable-5', null, false],
    ['claude-mythos-5', null, false],
    ['claude-mythos-preview', null, true],
    ['claude-opus-5-5', null, false],
    ['anthropic.claude-opus-5-5', null, false],
    ['claude-opus-5', 'disabled', false],
    ['claude-opus-4-8@20260101', 'disabled', false],
    ['claude-opus-4-7-20260101', 'disabled', false],
    ['claude-sonnet-5-5', 'between_tools', false],
    ['claude-sonnet-5', 'disabled', false],
    ['claude-haiku-5-5', 'disabled', false],
  ] as const)('applies the %s sampling and thinking limits', async (model, disabled, budget) => {
    const mockFetch = stubAnthropic();
    const adapter = createAnthropicAdapter({ apiKey: 'ant-test', model });
    const base = { model, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 4096 };
    const rejected = async (request: object, reason: string) => {
      const calls = mockFetch.mock.calls.length;
      await expect(adapter.complete({ prompt: 'Hello', ...request })).rejects.toMatchObject({
        name: 'AIInvalidRequestError',
        reason,
      });
      expect(mockFetch).toHaveBeenCalledTimes(calls);
    };

    // No temperature is sent: not the 0.7 default, not 0 (the falsy edge), not even 1.
    await adapter.complete({ prompt: 'Hello' });
    expect(sentBody(mockFetch, 0)).toEqual(base);
    await adapter.complete({ prompt: 'Hello', temperature: 0 });
    expect(sentBody(mockFetch, 1)).toEqual(base);
    await adapter.complete({
      prompt: 'Hello',
      temperature: 0.2,
      reasoning: { mode: 'effort', effort: 'low' },
    });
    expect(sentBody(mockFetch, 2)).toEqual({
      ...base,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'low' },
    });

    if (disabled) {
      await adapter.complete({ prompt: 'Hello', reasoning: { mode: 'disabled' } });
      expect(sentBody(mockFetch, 3)).toEqual({ ...base, thinking: { type: disabled } });
    } else {
      await rejected({ reasoning: { mode: 'disabled' } }, 'reasoning_disabled_unsupported');
    }

    const budgetRequest = {
      maxTokens: 8192,
      reasoning: { mode: 'budget', maxTokens: 2048 },
    } as const;
    if (budget) {
      await adapter.complete({ prompt: 'Hello', ...budgetRequest });
      expect(sentBody(mockFetch, mockFetch.mock.calls.length - 1)).toEqual({
        ...base,
        max_tokens: 8192,
        thinking: { type: 'enabled', budget_tokens: 2048, display: 'omitted' },
      });
    } else {
      await rejected(budgetRequest, 'reasoning_budget_unsupported');
    }
  });

  it('streams with the same limits', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const adapter = createAnthropicAdapter({ apiKey: 'ant-test', model: 'claude-sonnet-5-5' });
    for await (const event of adapter.stream({
      prompt: 'Hello',
      reasoning: { mode: 'disabled' },
    })) {
      void event;
    }

    expect(sentBody(mockFetch, 0)).toEqual({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 4096,
      stream: true,
      thinking: { type: 'between_tools' },
    });
  });

  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-6',
  ])('keeps the %s request bodies byte for byte', async (model) => {
    const mockFetch = stubAnthropic();
    const adapter = createAnthropicAdapter({ apiKey: 'ant-test', model });

    await adapter.complete({ prompt: 'Hello' });
    await adapter.complete({ prompt: 'Hello', temperature: 0.2 });
    await adapter.complete({ prompt: 'Hello', reasoning: { mode: 'disabled' } });

    const base = { model, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 4096 };
    expect(mockFetch.mock.calls.map((call) => call[1].body)).toEqual([
      JSON.stringify({ ...base, temperature: 0.7 }),
      JSON.stringify({ ...base, temperature: 0.2 }),
      JSON.stringify({ ...base, temperature: 0.7, thinking: { type: 'disabled' } }),
    ]);
  });
});
