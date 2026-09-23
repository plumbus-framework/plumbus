/** D01–D12: decision lifecycle boundary regressions (independent of vendor credentials). */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineDecision, DecisionRegistry } from '@plumbus/ai-decision';
import type {
  DecisionProviderAdapter,
  DecisionRequest,
  DecisionResult,
  DecisionRuntimeConfig,
} from '@plumbus/ai-decision/types';
import { createAIService, createCostTracker } from '../index.js';
import type { AICostRecord, AICostContext, AIServiceConfig, BudgetConfig } from '../index.js';
import { createTestContext } from '../../testing/index.js';

const questions = { p: { type: 'probability', instructions: '?' } } as const;
function response(): DecisionResult<typeof questions> {
  return {
    provider: 'stub',
    model: 'actual-model',
    answers: { p: { type: 'probability', probability: 0.7 } },
    usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
    cost: 0.1,
    costAvailable: true,
    latencyMs: 1,
  };
}
function setup(
  options: {
    run?: (request: DecisionRequest) => Promise<unknown>;
    decisions?: Partial<DecisionRuntimeConfig>;
    hook?: (record: AICostRecord) => void;
    budget?: BudgetConfig;
    security?: AIServiceConfig['security'];
  } = {},
) {
  const invoke = vi.fn(options.run ?? (async () => response()));
  const adapter = { name: 'stub', decide: invoke } as DecisionProviderAdapter;
  const tracker = createCostTracker(options.budget);
  const hook = vi.fn((record: AICostRecord, _context?: AICostContext) => options.hook?.(record));
  const ai = createAIService({
    providers: {},
    defaultProvider: '',
    decisions: { providers: { stub: adapter }, defaultProvider: 'stub', ...options.decisions },
    costTracker: tracker,
    onAICostRecorded: hook,
    security: options.security,
  });
  return { ai, adapter, invoke, tracker, hook };
}

describe('decision integration adversarial boundaries', () => {
  it('[D01] uses normalized provider and decision selectors consistently', async () => {
    const definition = defineDecision({ name: 'lookup', questions });
    const { ai } = setup({ decisions: { definitions: [definition] } });
    const result = await ai.decide({ decision: ' lookup ', provider: ' stub ', state: 'x' });
    expect(result.answers.p).toMatchObject({ probability: 0.7 });
  });

  it('[D02] resolves discovered definitions alongside an explicit registry', async () => {
    const registry = new DecisionRegistry();
    registry.register(defineDecision({ name: 'manual', questions }));
    const { ai } = setup({
      decisions: { registry, definitions: [defineDecision({ name: 'discovered', questions })] },
    });
    await expect(ai.decide({ decision: 'manual', state: 'x' })).resolves.toMatchObject({
      model: 'actual-model',
    });
    await expect(ai.decide({ decision: 'discovered', state: 'x' })).resolves.toMatchObject({
      model: 'actual-model',
    });
  });

  it('[D03] cannot approve an unrequested choice by mutating the provider request', async () => {
    const { ai, tracker } = setup({
      run: async (request) => {
        const criteria = (request.questions.pick as { criteria: Record<string, null> }).criteria;
        criteria.admin = null;
        return {
          ...response(),
          answers: {
            pick: {
              type: 'choice',
              choice: 'admin',
              probabilities: { yes: 0, no: 0, admin: 1 },
              confidence: 1,
            },
          },
        };
      },
    });
    await expect(
      ai.decide({
        state: 'x',
        questions: {
          pick: { type: 'choice', instructions: '?', criteria: { yes: null, no: null } },
        },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(tracker.getRecords()[0]).toMatchObject({ status: 'failed', cost: 0.1 });
  });

  it('[D04] snapshots billing context before an asynchronous provider call', async () => {
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { ai, hook } = setup({
      run: async () => {
        entered();
        await wait;
        return response();
      },
    });
    const costContext = { projectId: 'original-project' };
    const pending = ai.decide({ state: 'x', questions, costContext });
    await started;
    costContext.projectId = 'different-project';
    finish();
    await pending;
    expect(hook.mock.calls[0]?.[1]).toEqual({ projectId: 'original-project' });
  });

  it('[D05] observer mutation cannot corrupt the result or the budget tracker', async () => {
    const { ai, tracker } = setup({
      hook: (row) => {
        row.usage.inputTokens = 99999;
        row.usage.totalTokens = 99999;
        row.cost = 99;
      },
    });
    const result = await ai.decide({ state: 'x', questions });
    expect(result.usage.inputTokens).toBe(100);
    expect(result.cost).toBe(0.1);
    expect(tracker.getDailyUsage()).toMatchObject({ totalTokens: 100, totalCost: 0.1 });
  });

  it('[D06] caller mutation cannot rewrite a retained ledger-hook record', async () => {
    const { ai, hook, tracker } = setup();
    const result = await ai.decide({ state: 'x', questions });
    result.usage.inputTokens = 1;
    result.usage.totalTokens = 1;
    expect(hook.mock.calls[0]?.[0].usage.inputTokens).toBe(100);
    expect(tracker.getDailyUsage().totalTokens).toBe(100);
  });

  it('[D07] uses one record identity in the in-memory and persistence ledgers', async () => {
    const { ai, hook, tracker } = setup();
    await ai.decide({ state: 'x', questions });
    expect(hook.mock.calls[0]?.[0].id).toBe(tracker.getRecords()[0]?.id);
    expect(hook.mock.calls[0]?.[0].timestamp).toEqual(tracker.getRecords()[0]?.timestamp);
  });

  it('[D08] an error metadata getter cannot prevent a failed cost row', async () => {
    const failure = Object.assign(new Error('provider failed'), {
      usage: response().usage,
      cost: 0.1,
    });
    Object.defineProperty(failure, 'model', {
      get() {
        throw new Error('getter failed');
      },
    });
    const { ai, tracker } = setup({
      run: async () => {
        throw failure;
      },
    });
    await expect(ai.decide({ state: 'x', questions })).rejects.toBe(failure);
    expect(tracker.getRecords()).toHaveLength(1);
    expect(tracker.getRecords()[0]).toMatchObject({
      status: 'failed',
      cost: 0.1,
      usage: { inputTokens: 100 },
    });
  });

  it('[D09] rejects oversized input before provider work without poisoning the dollar budget', async () => {
    const { ai, invoke, tracker } = setup({ budget: { dailyCostLimit: 1 } });
    await expect(
      ai.decide({ state: 'x'.repeat(2 * 1024 * 1024), questions }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(invoke).not.toHaveBeenCalled();
    expect(tracker.getRecords()).toHaveLength(0);
    await expect(ai.decide({ state: 'small', questions })).resolves.toMatchObject({ cost: 0.1 });
  });

  it('[D10] one exhausted tenant cannot block another tenant', async () => {
    const { ai, tracker } = setup({ budget: { perTenantDailyLimit: 0.1 } });
    const a = createTestContext({ ai, auth: { tenantId: 'a' } });
    const b = createTestContext({ ai, auth: { tenantId: 'b' } });
    await a.ai.decide({ state: 'x', questions });
    await expect(a.ai.decide({ state: 'x', questions })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await b.ai.decide({ state: 'x', questions });
    expect(tracker.getRecords().map((row) => row.tenantId)).toEqual(['a', 'b']);
  });

  it('[D11] a mutable adapter name cannot change in-flight provider attribution', async () => {
    const { ai, adapter, tracker } = setup({
      run: async () => {
        (adapter as { name: string }).name = 'changed';
        return response();
      },
    });
    await expect(ai.decide({ state: 'x', questions })).resolves.toMatchObject({ provider: 'stub' });
    expect(tracker.getRecords()[0]?.provider).toBe('stub');
  });

  it('[D12] security inspects classified fields produced by a state-schema transform', async () => {
    const { ai, invoke, tracker } = setup({
      security: {
        mode: 'block',
        entities: [
          {
            name: 'Customer',
            fields: { secret: { type: 'string', options: { classification: 'highly_sensitive' } } },
          },
        ],
      },
    });
    const definition = defineDecision({
      name: 'transform',
      questions,
      state: z.string().transform((secret) => ({ secret })),
    });
    await expect(
      ai.decide({ state: 'sensitive text', decision: definition }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(invoke).not.toHaveBeenCalled();
    expect(tracker.getRecords()).toHaveLength(0);
  });
});
