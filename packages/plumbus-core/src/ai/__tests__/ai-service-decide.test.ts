import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineDecision } from '../../define/defineDecision.js';
import { createAIService } from '../ai-service.js';
import type { AICostRecord, AICostRecordInput } from '../cost-tracker.js';
import { createCostTracker } from '../cost-tracker.js';
import { choice, noul, score } from '../decision.js';
import type { DecisionAnswer, DecisionProviderAdapter } from '../decision.js';
import { DecisionRegistry } from '../decision-registry.js';
import { createExplainabilityTracker } from '../explainability.js';
import { createMockProvider } from './provider.test.js';

function createMockDecisionProvider(overrides?: Partial<DecisionProviderAdapter>) {
  const requests: Parameters<DecisionProviderAdapter['decide']>[0][] = [];
  const adapter: DecisionProviderAdapter = {
    name: 'mock-decisions',
    async decide(request) {
      requests.push(request);
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        answers[id] =
          question.type === 'noul'
            ? { type: 'noul', noul: 0.9 }
            : question.type === 'choice'
              ? {
                  type: 'choice',
                  choice: Object.keys(question.criteria)[0] as string,
                  probabilities: { [Object.keys(question.criteria)[0] as string]: 1 },
                  confidence: 0.8,
                }
              : {
                  type: 'score',
                  score: 1,
                  legend: { 0: 'low', 1: 'high' },
                  probabilities: { 0: 0.2, 1: 0.8 },
                  confidence: 0.7,
                };
      }
      return {
        model: request.model ?? 'mock-decision-1.0.0',
        answers,
        usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 },
      };
    },
    ...overrides,
  };
  return { adapter, requests };
}

function setupService(opts?: {
  decisions?: Partial<DecisionProviderAdapter>;
  costTracker?: boolean;
  explainability?: boolean;
  registry?: DecisionRegistry;
  defaultDecisionModel?: string;
  decisionOverrides?: Record<string, { provider?: string; model?: string }>;
  omitDecisionProvider?: boolean;
}) {
  const { adapter, requests } = createMockDecisionProvider(opts?.decisions);
  const records: AICostRecordInput[] = [];
  const costTracker = opts?.costTracker
    ? {
        ...createCostTracker(),
        record(entry: AICostRecordInput) {
          records.push(entry);
          return entry as AICostRecord;
        },
      }
    : undefined;
  const explainability = opts?.explainability ? createExplainabilityTracker() : undefined;

  const service = createAIService({
    providers: { mock: createMockProvider() },
    defaultProvider: 'mock',
    ...(opts?.omitDecisionProvider
      ? {}
      : {
          decisionProviders: { 'mock-decisions': adapter },
          defaultDecisionProvider: 'mock-decisions',
        }),
    ...(opts?.registry ? { decisionRegistry: opts.registry } : {}),
    ...(opts?.defaultDecisionModel ? { defaultDecisionModel: opts.defaultDecisionModel } : {}),
    ...(opts?.decisionOverrides ? { decisionOverrides: opts.decisionOverrides } : {}),
    ...(costTracker ? { costTracker } : {}),
    ...(explainability ? { explainability } : {}),
  });

  return { service, requests, records, explainability };
}

describe('ctx.ai.decide', () => {
  it('advertises the typed-decision feature', () => {
    const { service } = setupService();
    expect(service.features?.typedDecisions).toBe(true);
  });

  it('returns one answer per question, keyed by question id', async () => {
    const { service } = setupService();

    const result = await service.decide?.({
      state: 'Help! My payouts have been failing for 3 days.',
      questions: {
        isUrgent: noul('Does this convey urgency?'),
        department: choice('Which team?', { billing: 'Payments', technical: 'Bugs' }),
        frustration: score('How frustrated?', ['Calm', 'Angry']),
      },
    });

    expect(result?.answers.isUrgent).toEqual({ type: 'noul', noul: 0.9 });
    expect(result?.answers.department.choice).toBe('billing');
    expect(result?.answers.frustration.score).toBe(1);
    expect(result?.usage).toEqual({ inputTokens: 200, outputTokens: 10, totalTokens: 210 });
  });

  it('parses the state against a decision contract before calling the provider', async () => {
    const triage = defineDecision({
      name: 'support.triage',
      state: z.object({ message: z.string() }),
      questions: { isUrgent: noul('Urgent?') },
    });
    const { service, requests } = setupService();

    await expect(service.decide?.({ decision: triage, state: { message: 42 } })).rejects.toThrow();
    expect(requests).toHaveLength(0);

    await service.decide?.({ decision: triage, state: { message: 'hello' } });
    expect(requests[0]?.state).toEqual({ message: 'hello' });
  });

  it('resolves a decision by name through the registry', async () => {
    const registry = new DecisionRegistry();
    registry.register(
      defineDecision({ name: 'support.triage', questions: { isUrgent: noul('Urgent?') } }),
    );
    const { service, requests } = setupService({ registry });

    await service.decide?.({ decision: 'support.triage', state: 'x' });

    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(['isUrgent']);
  });

  it('explains how to resolve a decision name without a registry', async () => {
    const { service } = setupService();

    await expect(service.decide?.({ decision: 'support.triage', state: 'x' })).rejects.toThrow(
      /no decision registry configured/,
    );
  });

  it('rejects passing both a contract and inline questions', async () => {
    const triage = defineDecision({
      name: 'support.triage',
      questions: { isUrgent: noul('Urgent?') },
    });
    const { service } = setupService();

    await expect(
      service.decide?.({
        decision: triage,
        state: 'x',
        questions: { other: noul('Something else?') },
      }),
    ).rejects.toThrow(/not both/);
  });

  it('requires at least one of decision or questions', async () => {
    const { service } = setupService();

    await expect(service.decide?.({ state: 'x' })).rejects.toThrow(/is required/);
  });

  it('resolves the model from the call, then the override, then the contract, then the default', async () => {
    const triage = defineDecision({
      name: 'support.triage',
      questions: { isUrgent: noul('Urgent?') },
      model: { name: 'contract-model' },
    });

    const fromCall = setupService({ registry: new DecisionRegistry() });
    await fromCall.service.decide?.({ decision: triage, state: 'x', model: 'call-model' });
    expect(fromCall.requests[0]?.model).toBe('call-model');

    const fromOverride = setupService({
      decisionOverrides: { support_triage: { model: 'override-model' } },
    });
    await fromOverride.service.decide?.({ decision: triage, state: 'x' });
    expect(fromOverride.requests[0]?.model).toBe('override-model');

    const fromContract = setupService();
    await fromContract.service.decide?.({ decision: triage, state: 'x' });
    expect(fromContract.requests[0]?.model).toBe('contract-model');

    const fromDefault = setupService({ defaultDecisionModel: 'default-model' });
    await fromDefault.service.decide?.({ state: 'x', questions: { a: noul('?') } });
    expect(fromDefault.requests[0]?.model).toBe('default-model');
  });

  it('points at the env var and the add-on when no decision provider is configured', async () => {
    const { service } = setupService({ omitDecisionProvider: true });

    await expect(
      service.decide?.({ state: 'x', questions: { isUrgent: noul('Urgent?') } }),
    ).rejects.toThrow(/AI_DECISION_PROVIDER/);
  });

  it('enforces provider-declared limits before any network call', async () => {
    const { service, requests } = setupService({
      decisions: { capabilities: { maxChoiceOptions: 2 } },
    });

    await expect(
      service.decide?.({
        state: 'x',
        questions: { pick: choice('Pick one', { a: null, b: null, c: null }) },
      }),
    ).rejects.toThrow(/at most 2 options, got 3/);
    expect(requests).toHaveLength(0);
  });

  it('records cost under the decide operation with the answering model', async () => {
    const { service, records } = setupService({ costTracker: true });

    await service.decide?.({ state: 'x', questions: { isUrgent: noul('Urgent?') } });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: 'decide',
      provider: 'mock-decisions',
      model: 'mock-decision-1.0.0',
      status: 'success',
    });
    expect(records[0]?.usage.inputTokens).toBe(200);
  });

  it('prefers the adapter-supplied cost over the pricing catalog', async () => {
    const { service } = setupService({
      decisions: {
        async decide(request) {
          return {
            model: request.model ?? 'jev-1.13.0',
            answers: { isUrgent: { type: 'noul', noul: 0.5 } },
            usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
            cost: 1.23,
          };
        },
      },
    });

    const result = await service.decide?.({
      state: 'x',
      questions: { isUrgent: noul('Urgent?') },
    });

    expect(result?.cost).toBe(1.23);
  });

  it('falls back to the pricing catalog when the adapter reports no cost', async () => {
    const { service } = setupService({
      decisions: {
        async decide() {
          return {
            model: 'jev-1.13.0',
            answers: { isUrgent: { type: 'noul', noul: 0.5 } },
            usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
          };
        },
      },
    });

    const result = await service.decide?.({
      state: 'x',
      questions: { isUrgent: noul('Urgent?') },
    });

    expect(result?.cost).toBeCloseTo(0.042, 6);
  });

  it('records a failed row and rethrows when the provider fails', async () => {
    const { service, records } = setupService({
      costTracker: true,
      decisions: {
        decide: vi.fn(async () => {
          throw new Error('provider exploded');
        }),
      },
    });

    await expect(
      service.decide?.({ state: 'x', questions: { isUrgent: noul('Urgent?') } }),
    ).rejects.toThrow('provider exploded');

    expect(records[0]).toMatchObject({
      operation: 'decide',
      status: 'failed',
      cost: null,
      errorMessage: 'provider exploded',
    });
  });

  it('records an explanation carrying the answers and the decision name', async () => {
    const triage = defineDecision({
      name: 'support.triage',
      questions: { isUrgent: noul('Urgent?') },
    });
    const { service, explainability } = setupService({ explainability: true });

    await service.decide?.({ decision: triage, state: 'x' });

    const records = explainability?.getRecords() ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: 'decide',
      promptName: 'support.triage',
      provider: 'mock-decisions',
      model: 'mock-decision-1.0.0',
    });
    expect(records[0]?.output).toMatchObject({ isUrgent: { noul: 0.9 } });
  });

  it('forwards the abort signal to the provider', async () => {
    const { service, requests } = setupService();
    const controller = new AbortController();

    await service.decide?.({
      state: 'x',
      questions: { isUrgent: noul('Urgent?') },
      signal: controller.signal,
    });

    expect(requests[0]?.signal).toBe(controller.signal);
  });
});
