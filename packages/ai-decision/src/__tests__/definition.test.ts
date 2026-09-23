import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import { defineDecision, DecisionRegistry, validateDecisionResult } from '../index.js';

const questions = {
  team: {
    type: 'choice',
    instructions: 'Team?',
    criteria: { billing: 'Payments', support: 'Help' },
  },
} as const;

describe('named decision contracts', () => {
  it('snapshots and deeply freezes questions while preserving the Zod parser', () => {
    const input = {
      team: { ...questions.team, criteria: { billing: 'Payments', support: 'Help' } },
    };
    const state = z.object({ message: z.string() });
    const decision = defineDecision({ name: 'team', questions: input, state });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.questions.team.criteria)).toBe(true);
    input.team.criteria.billing = 'Changed';
    expect(decision.questions.team.criteria.billing).toBe('Payments');
    expect(decision.state?.parse({ message: 'hi' })).toEqual({ message: 'hi' });
  });
  it.each([
    { name: '' },
    { questions: {} },
    { questions: { p: { type: 'wrong', instructions: '?' } } },
    { state: { parse: () => 'fake parser' } },
    { questions: { p: { type: 'score', instructions: '?', criteria: ['Only one'] } } },
  ])('rejects invalid contracts: %j', (patch) => {
    expect(() => defineDecision({ name: 'test', questions, ...patch } as never)).toThrow();
  });
  it('rejects duplicate registrations and unknown names', () => {
    const registry = new DecisionRegistry();
    const definition = defineDecision({ name: 'team', questions });
    registry.register(definition);
    expect(registry.get('team').questions).toEqual(questions);
    expect(() => registry.register(definition)).toThrow(/Duplicate/);
    expect(() => registry.get('missing')).toThrow(/Unknown/);
  });
  it('uses the same choice consistency validation for normalized provider results', () => {
    const result = {
      provider: 'custom',
      model: 'm',
      usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
      cost: 0.1,
      costAvailable: true,
      latencyMs: 1,
      answers: {
        team: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.1, support: 0.9 },
          confidence: 0.8,
        },
      },
    };
    expect(() => validateDecisionResult(result, questions, 'custom')).toThrow(/Invalid normalized/);
    result.answers.team.probabilities = { billing: 0.9, support: 0.1 };
    expect(validateDecisionResult(result, questions, 'custom').answers.team.choice).toBe('billing');
  });
});
