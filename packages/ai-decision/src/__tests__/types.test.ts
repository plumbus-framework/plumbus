import { expect, it } from 'vitest';
import type { DecisionAnswers, DecisionProviderAdapter } from '../index.js';

// Checked by tsc through tsconfig.test.json, not just erased by Vitest's transformer.
function verifyInference(adapter: DecisionProviderAdapter) {
  const pending = adapter.decide({
    state: 'ticket',
    questions: {
      team: { type: 'choice', instructions: 'Team?', criteria: { billing: null, technical: null } },
      urgent: { type: 'probability', instructions: 'Urgent?' },
      priority: { type: 'score', instructions: 'Priority?', criteria: ['Low', 'High'] },
    },
  });
  return pending.then((result) => {
    const team: 'billing' | 'technical' = result.answers.team.choice;
    const probability: number = result.answers.urgent.probability;
    const score: number = result.answers.priority.score;
    // @ts-expect-error The chosen label is a literal union, not an arbitrary string.
    const invalid: 'sales' = result.answers.team.choice;
    // @ts-expect-error Probability results have no choice field.
    result.answers.urgent.choice;
    // @ts-expect-error Unknown question IDs are not part of the result.
    result.answers.missing;
    return { team, probability, score, invalid };
  });
}

it('exposes a structural interface shared by independent providers', () => {
  const answer: DecisionAnswers<{ p: { type: 'probability'; instructions: string } }> = {
    p: { type: 'probability', probability: 0.5 },
  };
  expect(answer.p.probability).toBe(0.5);
  expect(typeof verifyInference).toBe('function');
});
