import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineDecision, DecisionProviderError } from '@plumbus/ai-decision';
import type {
  DecisionProviderAdapter,
  DecisionResult,
  DecisionRuntimeConfig,
} from '@plumbus/ai-decision/types';
import { createAIService, createCostTracker, createExplainabilityTracker } from '../index.js';
import type { AICostRecord } from '../index.js';
import { defineCapability } from '../../define/index.js';
import { createTestContext, mockAI, runCapability } from '../../testing/index.js';
import { createTypeSafeDecisionAdapter } from '../../../../ai-decision-typesafe/src/index.js';
import { createLayaDecisionAdapter } from '../../../../ai-decision-laya/src/index.js';

const questions = { refund: { type: 'probability', instructions: 'Refund requested?' } } as const;
const usage = { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 };
function answer(cost: number | null = 0.25): DecisionResult<typeof questions> {
  return {
    provider: 'stub',
    model: 'actual-model',
    answers: { refund: { type: 'probability', probability: 0.9 } },
    usage,
    cost,
    costAvailable: cost !== null,
    latencyMs: 1,
  };
}
function setup(response: unknown = answer(), budget = {}) {
  const decide = vi.fn(async () => response);
  const provider = { name: 'stub', decide } as DecisionProviderAdapter;
  const costTracker = createCostTracker(budget);
  const hook = vi.fn();
  const explainability = createExplainabilityTracker();
  const ai = createAIService({
    providers: {},
    defaultProvider: '',
    decisions: { providers: { stub: provider }, defaultProvider: 'stub' },
    costTracker,
    onAICostRecorded: hook,
    explainability,
  });
  return { ai, provider, decide, costTracker, hook, explainability };
}

const capability = defineCapability({
  name: 'refund',
  domain: 'billing',
  kind: 'query',
  input: z.object({}),
  output: z.object({ probability: z.number() }),
  access: { roles: ['tester'] },
  effects: { ai: true },
  async handler(ctx) {
    const result = await ctx.ai.decide({
      state: 'Please refund',
      questions,
      costContext: { projectId: 'project-1' },
    });
    return { probability: result.answers.refund.probability };
  },
});

describe('decision accounting through core', () => {
  it('records exactly once through a capability with scoped identity, actual model, and billing context', async () => {
    const { ai, hook, costTracker, explainability } = setup();
    const result = await runCapability(
      capability,
      {},
      { ai, auth: { userId: 'actor-1', tenantId: 'tenant-1', roles: ['tester'] } },
    );
    expect(result.success).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'decide',
        model: 'actual-model',
        tenantId: 'tenant-1',
        actor: 'actor-1',
        usage,
        cost: 0.25,
        status: 'success',
      }),
      { projectId: 'project-1' },
    );
    expect(costTracker.getRecords()).toHaveLength(1);
    expect(explainability.getRecords()[0]).toMatchObject({
      operation: 'decide',
      tenantId: 'tenant-1',
    });
  });

  it('does not mix identities across concurrent capability calls', async () => {
    const { ai, hook } = setup();
    await Promise.all(
      ['one', 'two'].map((id) =>
        runCapability(
          capability,
          {},
          { ai, auth: { userId: id, tenantId: id, roles: ['tester'] } },
        ),
      ),
    );
    expect(hook.mock.calls.map(([record]) => [record.tenantId, record.actor]).sort()).toEqual([
      ['one', 'one'],
      ['two', 'two'],
    ]);
  });

  it.each([0, null])('retains explicit zero/unknown cost: %s', async (cost) => {
    const { ai, costTracker } = setup({ ...answer(cost), model: 'gpt-6-sol' });
    const result = await ai.decide({ state: 'x', questions });
    expect(result.cost).toBe(cost);
    expect(costTracker.getRecords()[0]?.cost).toBe(cost);
    expect(costTracker.getDailyUsage().costAvailable).toBe(cost !== null);
  });

  it('blocks the next call after unknown spend when a dollar cap is configured', async () => {
    const { ai, decide } = setup(answer(null), { dailyCostLimit: 1 });
    await ai.decide({ state: 'x', questions });
    await expect(ai.decide({ state: 'x', questions })).rejects.toMatchObject({ code: 'forbidden' });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('checks token budgets before dispatch and records no spend for a rejected preflight', async () => {
    const { ai, decide, hook } = setup(answer(), { maxTokensPerRequest: 1 });
    await expect(ai.decide({ state: 'long request', questions })).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('enforces spent dollar budgets', async () => {
    const { ai, decide } = setup(answer(0.25), { dailyCostLimit: 0.25 });
    await ai.decide({ state: 'x', questions });
    await expect(ai.decide({ state: 'x', questions })).rejects.toThrow();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it.each([
    { answers: {} },
    { answers: { refund: { type: 'probability', probability: 2 } } },
    { answers: { refund: { type: 'noul', noul: 0.8 } } },
    { cost: Number.NaN },
    { cost: Number.MAX_VALUE },
    { costAvailable: false },
    { usage: { inputTokens: -1, outputTokens: 0, totalTokens: -1 } },
  ])('records a failed row for malformed returned metadata/answers: %j', async (patch) => {
    const { ai, hook } = setup({ ...answer(), ...patch });
    await expect(ai.decide({ state: 'x', questions })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      operation: 'decide',
      status: 'failed',
      model: 'actual-model',
    });
    if (!('usage' in patch)) expect(hook.mock.calls[0]?.[0].usage).toEqual(usage);
  });

  it('preserves known billed metadata from a failed response and excludes provider messages', async () => {
    const { ai, decide, hook } = setup();
    decide.mockRejectedValueOnce(
      new DecisionProviderError('stub', 'invalid_response', 'SECRET RESPONSE BODY', {
        model: 'billed-model',
        usage,
        cost: 0.3,
      }),
    );
    await expect(ai.decide({ state: 'x', questions })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      cost: 0.3,
      usage,
      model: 'billed-model',
      status: 'failed',
    });
    expect(JSON.stringify(hook.mock.calls)).not.toContain('SECRET');
  });

  it.each([
    'network',
    'timeout',
    'cancelled',
  ] as const)('records %s failures with unknown cost', async (kind) => {
    const { ai, decide, hook } = setup();
    decide.mockRejectedValueOnce(new DecisionProviderError('stub', kind, 'failure'));
    await expect(
      ai.decide({ state: 'x', questions, model: 'requested-model' }),
    ).rejects.toMatchObject({ kind });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      cost: null,
      model: 'requested-model',
      status: 'failed',
    });
  });

  it('forwards cancellation and avoids a provider call when already cancelled', async () => {
    const { ai, decide, hook } = setup();
    const controller = new AbortController();
    await ai.decide({ state: 'x', questions, signal: controller.signal, timeoutMs: 500 });
    expect(decide.mock.calls[0]?.[0]).toMatchObject({ signal: controller.signal, timeoutMs: 500 });
    controller.abort();
    await expect(
      ai.decide({ state: 'x', questions, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not retry or change successful results when the ledger hook throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { ai, hook, decide, costTracker } = setup();
      hook.mockRejectedValue(new Error('storage failed'));
      expect((await ai.decide({ state: 'x', questions })).cost).toBe(0.25);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(costTracker.getRecords()).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('validates reusable state schemas, routes named decisions, and records the decision name', async () => {
    const { provider, decide } = setup();
    const hook = vi.fn();
    const definition = defineDecision({
      name: 'billing.refund',
      questions,
      state: z.object({ message: z.string() }),
      model: 'contract-model',
    });
    const ai = createAIService({
      providers: {},
      defaultProvider: '',
      decisions: {
        providers: { stub: provider },
        defaultProvider: 'stub',
        definitions: [definition],
      },
      onAICostRecorded: hook,
    });
    await expect(ai.decide({ decision: definition, state: { message: 1 } })).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
    await ai.decide({
      decision: 'billing.refund',
      state: { message: 'refund' },
      model: 'override',
    });
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      model: 'override',
      state: { message: 'refund' },
    });
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ decisionName: 'billing.refund' });
  });

  it.each([
    'block',
    'redact',
  ] as const)('applies %s security to structured questions as well as state', async (mode) => {
    const { provider, decide } = setup();
    const ai = createAIService({
      providers: {},
      defaultProvider: '',
      decisions: { providers: { stub: provider }, defaultProvider: 'stub' },
      security: {
        mode,
        entities: [
          {
            name: 'Account',
            fields: { secret: { type: 'string', options: { classification: 'highly_sensitive' } } },
          },
        ],
      },
    });
    const call = {
      state: { secret: 'PRIVATE STATE' },
      questions: {
        refund: {
          type: 'probability' as const,
          instructions: { secret: 'PRIVATE QUESTION', question: 'Refund?' },
        },
      },
    };
    if (mode === 'block') {
      await expect(ai.decide(call)).rejects.toThrow();
      expect(decide).not.toHaveBeenCalled();
    } else {
      await ai.decide(call);
      expect(JSON.stringify(decide.mock.calls)).not.toContain('PRIVATE');
      expect(JSON.stringify(decide.mock.calls)).toContain('[REDACTED]');
    }
  });

  it('exposes decision mocks through the normal test context', async () => {
    const ctx = createTestContext({ ai: mockAI({ decide: answer() }) });
    expect((await ctx.ai.decide({ state: 'x', questions })).answers.refund.probability).toBe(0.9);
    await expect(mockAI().decide({ state: 'x', questions })).rejects.toThrow(/Configure mockAI/);
  });

  it.each([
    'typesafe',
    'laya',
  ] as const)('records billed validation failures from the real %s adapter', async (providerName) => {
    const fetch = vi.fn(async () =>
      Response.json({
        model: 'jev-1.13.0',
        usage: { input_tokens: 1000, output_tokens: 0 },
        answers: { refund: { type: 'noul', noul: 9 } },
        routing: { model: 'english', repo: 'laya', reason: 'test' },
      }),
    );
    const provider =
      providerName === 'typesafe'
        ? createTypeSafeDecisionAdapter({ apiKey: 'synthetic-key', fetch })
        : createLayaDecisionAdapter({
            baseUrl: 'http://localhost/v1',
            costPerRequestUsd: 0.1,
            fetch,
          });
    const rows: AICostRecord[] = [];
    const decisions: DecisionRuntimeConfig = {
      providers: { [providerName]: provider },
      defaultProvider: providerName,
    };
    const ai = createAIService({
      providers: {},
      defaultProvider: '',
      decisions,
      onAICostRecorded: (row) => {
        rows.push(row);
      },
    });
    await expect(ai.decide({ state: 'x', questions })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: providerName, usage, status: 'failed' });
    expect(rows[0]?.cost).toBeCloseTo(providerName === 'typesafe' ? 0.000042 : 0.1, 10);
  });
});
