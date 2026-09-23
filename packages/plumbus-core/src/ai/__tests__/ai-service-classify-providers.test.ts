import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DecisionProviderError } from '@plumbus/ai-decision';
import type { DecisionProviderAdapter, DecisionRequest } from '@plumbus/ai-decision/types';
import { createAIService, createCostTracker, createExplainabilityTracker } from '../index.js';
import type { AIProviderAdapter, AIServiceConfig, ProviderRequest } from '../index.js';
import { defineCapability } from '../../define/index.js';
import { createTestContext, runCapability } from '../../testing/index.js';
import { createTypeSafeDecisionAdapter } from '../../../../ai-decision-typesafe/src/index.js';
import { createLayaDecisionAdapter } from '../../../../ai-decision-laya/src/index.js';

const labels = ['billing', 'technical', 'refund'];
const usage = { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 };
function textProvider(name: string): AIProviderAdapter {
  return {
    name,
    complete: vi.fn(async (request: ProviderRequest) => ({
      content: request.system?.startsWith('Classify') ? '["billing","invented"]' : '{"ok":true}',
      model: request.model ?? 'text-model',
      usage,
      cost: 0.2,
      finishReason: 'stop' as const,
    })),
    async *stream() {
      yield { type: 'done', usage };
    },
    async embed() {
      return { embeddings: [], model: 'unused', usage: { totalTokens: 0 } };
    },
  };
}
function setup(overrides: Partial<AIServiceConfig> = {}) {
  const text = textProvider('text');
  const other = textProvider('other');
  const invoke = vi.fn(async (request: DecisionRequest) => ({
    provider: 'native',
    model: 'actual-native-model',
    usage,
    cost: null,
    costAvailable: false,
    latencyMs: 1,
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key, i) => [
        key,
        { type: 'probability', probability: [0.9, 0.1, 0.5][i] ?? 0 },
      ]),
    ),
  }));
  const native = { name: 'native', decide: invoke } as DecisionProviderAdapter;
  const tracker = createCostTracker();
  const hook = vi.fn();
  const explanations = createExplainabilityTracker();
  const ai = createAIService({
    providers: { text, other },
    defaultProvider: 'text',
    defaultModel: 'text-default',
    decisions: { providers: { native }, defaultProvider: 'native', defaultModel: 'native-default' },
    costTracker: tracker,
    onAICostRecorded: hook,
    explainability: explanations,
    ...overrides,
  });
  return { ai, text, other, invoke, tracker, hook, explanations };
}

describe('classification provider routing', () => {
  it('keeps the existing generative default and filters unknown labels', async () => {
    const { ai, text, invoke, hook } = setup();
    expect(await ai.classify({ text: 'x', labels })).toEqual(['billing']);
    expect(text.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'text-default' }));
    expect(invoke).not.toHaveBeenCalled();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ operation: 'classify', provider: 'text' });
  });

  it('allows a text-provider/model override without changing generation routing', async () => {
    const { ai, other, text } = setup();
    await ai.classify({ text: 'x', labels, provider: 'other', model: 'custom' });
    expect(other.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'custom' }));
    expect(await ai.generate({ prompt: 'hello', input: {} })).toBe('{"ok":true}');
    expect(text.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'text-default' }));
  });

  it.each([
    [undefined, ['billing', 'refund']],
    [0.95, []],
    [0, labels],
  ] as const)('preserves multi-label selection at threshold %s', async (threshold, expected) => {
    const { ai, invoke, tracker, explanations } = setup();
    const signal = new AbortController().signal;
    expect(await ai.classify({ text: 'x', labels, provider: 'native', threshold, signal })).toEqual(
      expected,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      state: { text: 'x' },
      signal,
      model: 'native-default',
    });
    expect(Object.keys(invoke.mock.calls[0]?.[0].questions ?? {})).toEqual([
      'label_0',
      'label_1',
      'label_2',
    ]);
    expect(tracker.getRecords()).toHaveLength(1);
    expect(tracker.getRecords()[0]).toMatchObject({ operation: 'classify', cost: null });
    expect(explanations.getRecords()[0]).toMatchObject({ operation: 'classify', output: expected });
  });

  it('keeps unknown decision cost unknown even for a name in the text pricing catalog', async () => {
    const { ai, invoke, tracker } = setup();
    const base = await invoke({
      state: 'x',
      questions: { label_0: { type: 'probability', instructions: '?' } },
    });
    invoke.mockClear();
    invoke.mockResolvedValueOnce({ ...base, model: 'gpt-6-sol' });
    expect(
      await ai.classify({
        text: 'x',
        labels: ['billing'],
        provider: 'native',
        model: 'request-model',
      }),
    ).toEqual(['billing']);
    expect(tracker.getRecords()[0]).toMatchObject({
      operation: 'classify',
      model: 'gpt-6-sol',
      cost: null,
    });
    expect(invoke.mock.calls[0]?.[0].model).toBe('request-model');
  });

  it('records one failed classification row with preserved billing metadata', async () => {
    const { ai, invoke, hook } = setup();
    invoke.mockRejectedValueOnce(
      new DecisionProviderError('native', 'invalid_response', 'invalid answer', {
        model: 'billed-model',
        usage,
        cost: 0.15,
      }),
    );
    await expect(ai.classify({ text: 'x', labels, provider: 'native' })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      operation: 'classify',
      status: 'failed',
      model: 'billed-model',
      cost: 0.15,
      usage,
    });
  });

  it.each([
    'budget',
    'security',
  ] as const)('enforces %s before native provider work', async (guard) => {
    const { ai, invoke, hook } = setup(
      guard === 'budget'
        ? { costTracker: createCostTracker({ maxTokensPerRequest: 1 }) }
        : {
            security: {
              mode: 'block',
              entities: [
                {
                  name: 'Message',
                  fields: {
                    text: { type: 'string', options: { classification: 'highly_sensitive' } },
                  },
                },
              ],
            },
          },
    );
    await expect(ai.classify({ text: 'secret', labels, provider: 'native' })).rejects.toMatchObject(
      { code: 'forbidden' },
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'native', threshold: -0.1 },
    { provider: 'native', threshold: Number.NaN },
    { provider: 'native', threshold: 1.1 },
    { provider: 'text', threshold: 0.5 },
    { provider: '__proto__' },
    { provider: 'native', labels: [] },
    { provider: 'native', labels: Array.from({ length: 257 }, (_, i) => String(i)) },
  ])('rejects unsupported options before dispatch: %j', async (options) => {
    const { ai, invoke, text, hook } = setup();
    await expect(ai.classify({ text: 'x', labels, ...options })).rejects.toMatchObject({
      code: 'validation',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(text.complete).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects an explicit provider name registered in both registries', async () => {
    const duplicated = textProvider('native');
    const { ai, invoke, hook } = setup({ providers: { native: duplicated } });
    await expect(ai.classify({ text: 'x', labels, provider: 'native' })).rejects.toThrow(
      'both registries',
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(duplicated.complete).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([
    'typesafe',
    'laya',
  ] as const)('uses the %s adapter through a capability and records classification once', async (provider) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        model: 'jev-1.13.0',
        usage: { input_tokens: 1000, output_tokens: 0 },
        routing: { model: 'english', repo: 'fixture', reason: 'test' },
        answers: {
          label_0: { type: 'noul', noul: 0.9 },
          label_1: { type: 'noul', noul: 0.2 },
          label_2: { type: 'noul', noul: 0.7 },
        },
      }),
    );
    const adapter =
      provider === 'typesafe'
        ? createTypeSafeDecisionAdapter({ apiKey: 'synthetic', fetch })
        : createLayaDecisionAdapter({
            baseUrl: 'http://localhost/v1',
            costPerRequestUsd: 0.1,
            fetch,
          });
    const { ai, hook } = setup({ decisions: { providers: { [provider]: adapter } } });
    const capability = defineCapability({
      name: 'classify',
      domain: 'testing',
      kind: 'query',
      input: z.object({}),
      output: z.array(z.string()),
      access: { roles: ['tester'] },
      effects: { data: [], events: [], external: [], ai: true },
      handler: async (ctx) =>
        ctx.ai.classify({
          text: 'Refund please',
          labels,
          provider,
          costContext: { projectId: 'project' },
        }),
    });
    const result = await runCapability(
      capability,
      {},
      {
        ctx: createTestContext({
          ai,
          auth: { roles: ['tester'], tenantId: 'tenant', userId: 'actor' },
        }),
      },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(['billing', 'refund']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.questions.label_0).toMatchObject({
      type: 'noul',
      instructions: { label: 'billing' },
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'classify',
        provider,
        tenantId: 'tenant',
        actor: 'actor',
        usage,
      }),
      { projectId: 'project' },
    );
    expect(hook.mock.calls[0]?.[0].cost).toBeCloseTo(provider === 'typesafe' ? 0.000042 : 0.1, 10);
  });
});
