import { describe, expect, it, vi } from 'vitest';
import type {
  AIFinalGenerateResult,
  AIGenerateWithUsageConfig,
  AIService,
  AITokenUsage,
  AIToolCallsGenerateResult,
  AIToolEnabledGenerateResult,
} from '../../types/context.js';
import type { AITool, AIToolCall } from '../provider.js';
import { runToolLoop, safeJsonStringify } from '../tool-loop.js';

const sampleTool: AITool = {
  name: 'do_thing',
  description: 'Do a thing',
  parameters: {
    type: 'object',
    properties: { x: { type: 'number' } },
    required: ['x'],
  },
};

function usage(inputTokens: number, outputTokens: number): AITokenUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function parsedCall(id: string, name: string, args: unknown): AIToolCall {
  return { id, name, argumentsStatus: 'parsed', arguments: args };
}

function invalidCall(id: string, name: string): AIToolCall {
  return {
    id,
    name,
    argumentsStatus: 'invalid',
    rawArguments: '{bad',
    parseError: 'unexpected token',
  };
}

function toolCallsResult(
  toolCalls: AIToolCall[],
  usageValue = usage(10, 5),
  cost = 0.01,
  providerState?: AIToolCallsGenerateResult['providerState'],
): AIToolCallsGenerateResult {
  return {
    finishReason: 'tool_calls',
    toolCalls,
    usage: usageValue,
    model: 'mock-model',
    provider: 'mock',
    cost,
    ...(providerState ? { providerState } : {}),
  };
}

function stopResult<T extends Record<string, unknown>>(
  data: T,
  usageValue = usage(10, 5),
  cost = 0.01,
): AIFinalGenerateResult<T> {
  return {
    finishReason: 'stop',
    data,
    usage: usageValue,
    model: 'mock-model',
    provider: 'mock',
    cost,
  };
}

function exhaustedLoopScript(
  maxRounds: number,
  finalData: Record<string, unknown> = { done: true },
): AIToolEnabledGenerateResult[] {
  const script: AIToolEnabledGenerateResult[] = [];
  for (let i = 0; i < maxRounds; i++) {
    script.push(
      toolCallsResult([parsedCall(`call_${i}`, 'do_thing', { x: i })], usage(10, 5), 0.01),
    );
  }
  script.push(stopResult(finalData, usage(20, 10), 0.02));
  return script;
}

function createScriptedAI(script: AIToolEnabledGenerateResult[]) {
  const configs: AIGenerateWithUsageConfig[] = [];
  let index = 0;

  const ai = {
    async recordProviderCost() {},
    checkProviderCostBudget() {},
    async generate() {
      return {};
    },
    generateWithUsage: vi.fn(async (config: AIGenerateWithUsageConfig) => {
      configs.push(config);
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`Unexpected generateWithUsage call #${index}`);
      }
      return next;
    }) as AIService['generateWithUsage'],
    async *streamGenerate() {
      yield {
        type: 'done' as const,
        result: {},
        usage: usage(0, 0),
        model: 'mock-model',
        provider: 'mock',
        cost: 0,
      };
    },
    async extract() {
      return {};
    },
    async classify() {
      return [];
    },
    async retrieve() {
      return [];
    },
  } satisfies AIService;

  return { ai, configs };
}

const baseParams = {
  prompt: 'tool-prompt',
  input: {},
  tools: [sampleTool],
};

describe('runToolLoop', () => {
  it('returns the flat final result immediately when the first response has no tool calls', async () => {
    const execute = vi.fn();
    const { ai } = createScriptedAI([stopResult({ answer: 'done' })]);

    const result = await runToolLoop(ai, { ...baseParams, execute });

    expect(result.final.data).toBeDefined();
    expect(result.rounds).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes each parsed tool call in order and appends assistant then tool messages', async () => {
    const call1 = parsedCall('call_1', 'do_thing', { x: 1 });
    const call2 = parsedCall('call_2', 'do_thing', { x: 2 });
    const execute = vi.fn(async (call: Extract<AIToolCall, { argumentsStatus: 'parsed' }>) => ({
      echo: call.arguments,
    }));
    const { ai } = createScriptedAI([toolCallsResult([call1, call2]), stopResult({ done: true })]);

    const result = await runToolLoop(ai, { ...baseParams, execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]?.id).toBe('call_1');
    expect(execute.mock.calls[1]?.[0]?.id).toBe('call_2');

    const tail = result.messages.slice(-3);
    expect(tail[0]).toMatchObject({ role: 'assistant', toolCalls: [call1, call2] });
    expect(tail[1]).toMatchObject({ role: 'tool', toolCallId: 'call_1', name: 'do_thing' });
    expect(tail[2]).toMatchObject({ role: 'tool', toolCallId: 'call_2', name: 'do_thing' });
  });

  it('preserves opaque provider assistant state on the next tool round', async () => {
    const call = parsedCall('call_state', 'do_thing', { x: 1 });
    const providerState = {
      provider: 'anthropic',
      content: [{ type: 'thinking', thinking: 'opaque', signature: 'sig' }],
    };
    const { ai, configs } = createScriptedAI([
      toolCallsResult([call], usage(10, 5), 0.01, providerState),
      stopResult({ done: true }),
    ]);

    await runToolLoop(ai, {
      ...baseParams,
      execute: async () => ({ ok: true }),
    });

    expect(configs[1]?.messages?.[0]).toEqual(
      expect.objectContaining({ role: 'assistant', providerState }),
    );
  });

  it('never executes an invalid-argument call and emits a tool_arguments_invalid observation', async () => {
    const badCall = invalidCall('call_bad', 'do_thing');
    const execute = vi.fn();
    const { ai } = createScriptedAI([toolCallsResult([badCall]), stopResult({ done: true })]);

    const result = await runToolLoop(ai, { ...baseParams, execute });

    expect(execute).not.toHaveBeenCalled();
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage?.content ?? '{}') as {
      code?: string;
      rawArguments?: string;
      parseError?: string;
    };
    expect(parsed.code).toBe('tool_arguments_invalid');
    expect(parsed.rawArguments).toBeUndefined();
    expect(parsed.parseError).toBeUndefined();
  });

  it('catches executor errors and emits a tool_execution_failed observation without rejecting', async () => {
    const secret = 'super-secret-internal-error-detail';
    const execute = vi.fn(async () => {
      throw new Error(secret);
    });
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('call_1', 'do_thing', { x: 1 })]),
      stopResult({ done: true }),
    ]);

    const result = await runToolLoop(ai, { ...baseParams, execute });

    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage?.content ?? '{}') as { code?: string };
    expect(parsed.code).toBe('tool_execution_failed');
    expect(toolMessage?.content).not.toContain(secret);
  });

  it('stops after maxRounds and makes one final call omitting both tools and toolChoice', async () => {
    const maxRounds = 3;
    const execute = vi.fn(async () => ({ ok: true }));
    const { ai, configs } = createScriptedAI(exhaustedLoopScript(maxRounds));

    const result = await runToolLoop(ai, { ...baseParams, execute, maxRounds });

    expect(result.rounds).toBe(maxRounds);
    const lastConfig = configs[configs.length - 1];
    expect(lastConfig).toBeDefined();
    expect('tools' in lastConfig).toBe(false);
    expect('toolChoice' in lastConfig).toBe(false);
  });

  it('defaults maxRounds to 8 and clamps above the hard maximum of 20', async () => {
    const execute = vi.fn(async () => ({ ok: true }));

    const defaultResult = await runToolLoop(createScriptedAI(exhaustedLoopScript(8)).ai, {
      ...baseParams,
      execute,
    });
    expect(defaultResult.rounds).toBe(8);

    const clampedResult = await runToolLoop(createScriptedAI(exhaustedLoopScript(20)).ai, {
      ...baseParams,
      execute,
      maxRounds: 100,
    });
    expect(clampedResult.rounds).toBe(20);
  });

  it('aggregates usage and cost across every round', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const script = [
      toolCallsResult([parsedCall('call_1', 'do_thing', { x: 1 })], usage(10, 5), 0.01),
      toolCallsResult([parsedCall('call_2', 'do_thing', { x: 2 })], usage(20, 10), 0.02),
      stopResult({ done: true }, usage(30, 15), 0.03),
    ];
    const { ai } = createScriptedAI(script);

    const result = await runToolLoop(ai, { ...baseParams, execute, maxRounds: 5 });

    expect(result.aggregatedUsage.totalTokens).toBe(90);
    expect(result.aggregatedCost).toBeCloseTo(0.06);
  });

  it('default formatObservation is cycle-safe and BigInt-safe', async () => {
    const execute = vi.fn(async () => {
      const value: { self?: unknown; big: bigint } = { big: 42n };
      value.self = value;
      return value;
    });
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('call_1', 'do_thing', { x: 1 })]),
      stopResult({ done: true }),
    ]);

    const result = await runToolLoop(ai, { ...baseParams, execute });
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();

    const parsed = JSON.parse(toolMessage?.content ?? '{}') as {
      result?: { self?: string; big?: string };
    };
    expect(parsed.result?.self).toBe('[Circular]');
    expect(parsed.result?.big).toBe('42');
  });

  it('truncates oversized successful results to a valid-JSON envelope within maxObservationBytes', async () => {
    const execute = vi.fn(async () => ({ blob: 'x'.repeat(10_000) }));
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('call_1', 'do_thing', { x: 1 })]),
      stopResult({ done: true }),
    ]);

    const result = await runToolLoop(ai, {
      ...baseParams,
      execute,
      maxObservationBytes: 512,
    });
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(new TextEncoder().encode(toolMessage?.content ?? '').length).toBeLessThanOrEqual(512);

    const parsed = JSON.parse(toolMessage?.content ?? '{}') as { truncated?: boolean };
    expect(parsed.truncated).toBe(true);
  });

  it('safeJsonStringify serializes duplicate sibling references without [Circular]', () => {
    const shared = { id: 'u1' };
    const text = safeJsonStringify({ user: shared, owner: shared });
    const parsed = JSON.parse(text) as { user: { id: string }; owner: { id: string } };
    expect(parsed.user.id).toBe('u1');
    expect(parsed.owner.id).toBe('u1');
    expect(text).not.toContain('[Circular]');
  });

  it('safeJsonStringify preserves Date ISO strings and omits functions as valid JSON', () => {
    const text = safeJsonStringify({ at: new Date('2020-01-02T03:04:05.000Z'), fn: () => 1 });
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text) as { at: string; fn?: unknown };
    expect(parsed.at).toBe('2020-01-02T03:04:05.000Z');
    expect(parsed.fn).toBeUndefined();
  });

  it('safeJsonStringify serializes sparse arrays with null holes', () => {
    const arr: unknown[] = [];
    arr[1] = 1;
    const text = safeJsonStringify(arr);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual([null, 1]);
  });

  it('safeJsonStringify serializes function array elements as null', () => {
    const text = safeJsonStringify([() => 1]);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual([null]);
  });

  it('does not mutate the caller-provided messages array', async () => {
    const initialMessages = [{ role: 'user' as const, content: 'hello' }];
    const snapshot = structuredClone(initialMessages);
    const execute = vi.fn(async () => ({ ok: true }));
    const { ai } = createScriptedAI([
      toolCallsResult([parsedCall('call_1', 'do_thing', { x: 1 })]),
      stopResult({ done: true }),
    ]);

    const result = await runToolLoop(ai, {
      ...baseParams,
      messages: initialMessages,
      execute,
    });

    expect(initialMessages).toEqual(snapshot);
    expect(initialMessages.length).toBe(1);
    expect(result.messages).not.toBe(initialMessages);
    expect(result.messages.length).toBeGreaterThan(initialMessages.length);
  });
});
