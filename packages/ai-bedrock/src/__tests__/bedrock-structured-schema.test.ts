// Native structured outputs (`structuredOutputs: 'native'`) send core's provider-neutral schema
// as it is. Bedrock's "Supported JSON Schema features" asks for no object root and lists
// `anyOf`, so no envelope or projection is needed here: the shapes core's
// `zodToProviderJsonSchema` now emits for an array output, a tuple and `z.string().cidr()` go out
// unchanged (as a JSON string, which Converse takes).
import { describe, expect, it, vi } from 'vitest';
import { createBedrockAdapter } from '../bedrock-adapter.js';
import type { BedrockPricingStore } from '../pricing.js';

function mockPricing(): BedrockPricingStore {
  return {
    warm: vi.fn().mockResolvedValue(undefined),
    getRate: vi.fn().mockReturnValue({ inputPerMTok: 1, outputPerMTok: 5, kind: 'text' as const }),
    listRates: vi.fn().mockReturnValue([]),
    calculateCost: vi.fn().mockReturnValue(0),
  };
}

const card = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
};

describe('Bedrock native structured outputs', () => {
  it.each([
    ['an array root', { type: 'array', items: card }],
    [
      'a tuple root',
      {
        type: 'array',
        minItems: 1,
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        description: 'Must hold exactly 2 items, in this order: (1) string; (2) number.',
      },
    ],
    [
      'a union root whose branches are whole schemas',
      {
        anyOf: [
          { type: 'string', pattern: '^10\\.' },
          { type: 'string', pattern: '^fd' },
        ],
      },
    ],
  ])('preserves %s with prompt caching enabled, without an envelope', async (_label, responseSchema) => {
    const send = vi.fn().mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: '[]' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const adapter = createBedrockAdapter({
      region: 'us-east-1',
      pricingStore: mockPricing(),
      runtimeClient: { send } as never,
      warmPricingOnCreate: false,
      structuredOutputs: 'native',
    });

    const result = await adapter.complete({
      prompt: 'hi',
      system: 'Return the requested structure.',
      responseFormat: 'json',
      responseSchema,
      cache: { system: true, messages: true },
    });

    const input = (send.mock.calls[0]?.[0] as { input: Record<string, any> }).input;
    const sent = input.outputConfig?.textFormat?.structure?.jsonSchema?.schema;
    expect(JSON.parse(String(sent))).toEqual(responseSchema);
    expect(input.system).toEqual([
      { text: 'Return the requested structure.' },
      { cachePoint: { type: 'default' } },
    ]);
    expect(input.messages[0].content).toEqual([
      { text: 'hi' },
      { cachePoint: { type: 'default' } },
    ]);
    // The answer is passed on as the model wrote it.
    expect(result.content).toBe('[]');
  });
});
