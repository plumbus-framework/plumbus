import { describe, expect, it, vi } from 'vitest';
import { createBedrockAdapter } from '../bedrock-adapter.js';
import type { BedrockPricingStore } from '../pricing.js';

function mockPricing(inputPerMTok = 1.1, outputPerMTok = 5.5): BedrockPricingStore {
  return {
    warm: vi.fn().mockResolvedValue(undefined),
    getRate: vi.fn().mockReturnValue({ inputPerMTok, outputPerMTok, kind: 'text' as const }),
    listRates: vi.fn().mockReturnValue([
      {
        id: 'anthropic.claude-haiku-4-5',
        rate: { inputPerMTok, outputPerMTok, kind: 'text' as const },
      },
    ]),
    calculateCost: vi.fn().mockImplementation((_model, usage) => {
      return Number(
        (
          (usage.inputTokens * inputPerMTok + usage.outputTokens * outputPerMTok) /
          1_000_000
        ).toFixed(6),
      );
    }),
  };
}

describe('createBedrockAdapter', () => {
  it('complete maps Converse response and attaches cost', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'hello' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const pricing = mockPricing();
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: pricing,
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    const result = await adapter.complete({ prompt: 'hi', model: 'anthropic.claude-haiku-4-5' });
    expect(result.content).toBe('hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.totalTokens).toBe(15);
    expect(result.cost).toBe(pricing.calculateCost('anthropic.claude-haiku-4-5', result.usage));
    expect(send).toHaveBeenCalled();
  });

  it('complete maps tool_use to tool_calls', async () => {
    const send = vi.fn().mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 't1',
                name: 'lookup',
                input: { q: 'x' },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    const result = await adapter.complete({
      prompt: 'hi',
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
    });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0]?.name).toBe('lookup');
  });

  it('embed uses InvokeModel and sets cost', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ embedding: [0.1, 0.2], inputTextTokenCount: 4 }),
    );
    const send = vi.fn().mockResolvedValue({ body });
    const pricing = mockPricing(0.02, 0);
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: pricing,
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    const result = await adapter.embed({ texts: ['a'] });
    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(result.usage.totalTokens).toBe(4);
    expect(result.cost).toBeDefined();
  });

  it('stream yields deltas and done with cost', async () => {
    async function* events() {
      yield { contentBlockDelta: { delta: { text: 'Hel' } } };
      yield { contentBlockDelta: { delta: { text: 'lo' } } };
      yield { metadata: { usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } } };
      yield { messageStop: { stopReason: 'end_turn' } };
    }
    const send = vi.fn().mockResolvedValue({ stream: events() });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    const collected: string[] = [];
    let doneCost: number | undefined;
    for await (const ev of adapter.stream({ prompt: 'x' })) {
      if (ev.type === 'content_delta' && ev.delta) collected.push(ev.delta);
      if (ev.type === 'done') doneCost = ev.cost;
    }
    expect(collected.join('')).toBe('Hello');
    expect(doneCost).toBeTypeOf('number');
  });

  it('listModels returns rates from pricing store', async () => {
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send: vi.fn() } as never,
      warmPricingOnCreate: false,
    });
    const models = await adapter.listModels?.({ kind: 'text' });
    expect(models?.[0]?.id).toBe('anthropic.claude-haiku-4-5');
    expect(models?.[0]?.inputPerMTok).toBe(1.1);
  });

  it('loads pricingFilePath even when warmPricingOnCreate is false', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = join(tmpdir(), `plumbus-bedrock-adapter-pricing-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'pricing.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          'amazon.nova-lite-v1': { inputPerMTok: 0.06, outputPerMTok: 0.24, kind: 'text' },
        },
      }),
    );
    try {
      const adapter = createBedrockAdapter({
        region: 'eu-north-1',
        pricingFilePath: file,
        runtimeClient: { send: vi.fn() } as never,
        warmPricingOnCreate: false,
      });
      const models = await adapter.listModels?.({ kind: 'text' });
      expect(models?.some((m) => m.id === 'amazon.nova-lite-v1')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Extract AWS SDK command `.input` from a mock send call. */
function commandInput(send: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const cmd = send.mock.calls[callIndex]?.[0] as { input?: Record<string, unknown> } | undefined;
  return cmd?.input ?? {};
}

describe('createBedrockAdapter adversarial / edge cases', () => {
  it('1. toolChoice none omits toolConfig on complete (Bedrock has no true none)', async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    await adapter.complete({
      prompt: 'hi',
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
      toolChoice: 'none',
    });

    expect(commandInput(send).toolConfig).toBeUndefined();
  });

  it('2. stream sends toolConfig when tools are present', async () => {
    async function* events() {
      yield { messageStop: { stopReason: 'end_turn' } };
    }
    const send = vi.fn().mockResolvedValue({ stream: events() });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    for await (const _ of adapter.stream({
      prompt: 'hi',
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
    })) {
      // drain
    }

    const toolConfig = commandInput(send).toolConfig as { tools?: unknown[] } | undefined;
    expect(toolConfig?.tools?.length).toBe(1);
  });

  it('3. stream omits toolConfig when toolChoice is none', async () => {
    async function* events() {
      yield { messageStop: { stopReason: 'end_turn' } };
    }
    const send = vi.fn().mockResolvedValue({ stream: events() });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    for await (const _ of adapter.stream({
      prompt: 'hi',
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
      toolChoice: 'none',
    })) {
      // drain
    }

    expect(commandInput(send).toolConfig).toBeUndefined();
  });

  it('4. stream accumulates partial tool-use JSON across deltas', async () => {
    async function* events() {
      yield {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 't1', name: 'lookup' } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"q":' } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '"x"}' } },
        },
      };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
      yield { messageStop: { stopReason: 'tool_use' } };
    }
    const send = vi.fn().mockResolvedValue({ stream: events() });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    let done:
      | { toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }> }
      | undefined;
    for await (const ev of adapter.stream({ prompt: 'x' })) {
      if (ev.type === 'done') done = ev;
    }
    expect(done?.toolCalls?.[0]?.name).toBe('lookup');
    expect(done?.toolCalls?.[0]?.arguments).toEqual({ q: 'x' });
  });

  it('5. multi-turn history maps assistant toolCalls + tool results for Converse', async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: 'done' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    await adapter.complete({
      prompt: '',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'get_weather',
              argumentsStatus: 'parsed',
              arguments: { city: 'TLV' },
            },
          ],
        },
        { role: 'tool', content: '{"temp":22}', toolCallId: 'call_1' },
      ],
    });

    const messages = commandInput(send).messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content.some((c) => c.toolUse != null)).toBe(true);
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.content.some((c) => c.toolResult != null)).toBe(true);
  });

  it('6. AccessDeniedException is remapped with Bedrock prefix', async () => {
    const err = new Error('not authorized to perform: bedrock:Converse');
    err.name = 'AccessDeniedException';
    const send = vi.fn().mockRejectedValue(err);
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    await expect(adapter.complete({ prompt: 'hi' })).rejects.toThrow(
      /Bedrock request failed \(AccessDeniedException\)/,
    );
  });

  it('7. empty assistant content still returns a structured response', async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    const result = await adapter.complete({ prompt: 'hi' });
    expect(result.content).toBe('');
    expect(result.finishReason).toBe('stop');
    expect(result.cost).toBeTypeOf('number');
  });

  it('8. Converse cache token fields map onto usage for cost', async () => {
    const pricing = mockPricing(1, 1);
    pricing.calculateCost = vi.fn().mockReturnValue(0.001);
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: 'x' }] } },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 20,
      },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: pricing,
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    const result = await adapter.complete({ prompt: 'hi' });
    expect(result.usage.cachedInputTokens).toBe(40);
    expect(result.usage.cacheWriteTokens).toBe(20);
    expect(pricing.calculateCost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteTokens: 20,
      }),
    );
  });

  it('9. missing pricingFilePath fails clearly on first call', async () => {
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingFilePath: `/tmp/plumbus-bedrock-missing-${Date.now()}.json`,
      runtimeClient: { send: vi.fn() } as never,
      warmPricingOnCreate: false,
    });

    await expect(adapter.listModels?.()).rejects.toThrow();
  });

  it('10. named toolChoice forces a specific Bedrock tool', async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    await adapter.complete({
      prompt: 'hi',
      tools: [
        { name: 'a', description: 'd', parameters: { type: 'object' } },
        { name: 'b', description: 'd', parameters: { type: 'object' } },
      ],
      toolChoice: { type: 'function', function: { name: 'b' } },
    });

    const toolConfig = commandInput(send).toolConfig as {
      toolChoice?: { tool?: { name?: string } };
    };
    expect(toolConfig.toolChoice?.tool?.name).toBe('b');
  });

  it('11. system prompt is sent as Converse system blocks', async () => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    await adapter.complete({ prompt: 'hi', system: 'Be terse.' });
    const system = commandInput(send).system as Array<{ text?: string }>;
    expect(system?.[0]?.text).toBe('Be terse.');
  });

  it('12. stream marks invalid tool JSON as argumentsStatus invalid', async () => {
    async function* events() {
      yield {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 't1', name: 'lookup' } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{not-json' } },
        },
      };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'tool_use' } };
    }
    const send = vi.fn().mockResolvedValue({ stream: events() });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
    });

    let done: { toolCalls?: Array<{ argumentsStatus: string; rawArguments?: string }> } | undefined;
    for await (const ev of adapter.stream({ prompt: 'x' })) {
      if (ev.type === 'done') done = ev;
    }
    expect(done?.toolCalls?.[0]?.argumentsStatus).toBe('invalid');
    expect(done?.toolCalls?.[0]?.rawArguments).toBe('{not-json');
  });
});
