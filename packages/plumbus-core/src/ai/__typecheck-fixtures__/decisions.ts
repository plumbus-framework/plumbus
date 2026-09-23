import type { AIService } from '../../../dist/index.js';
import type { DecisionDefinition } from '@plumbus/ai-decision/types';

declare const ai: AIService;
const questions = {
  team: { type: 'choice', instructions: 'Team?', criteria: { billing: null, support: null } },
  p: { type: 'probability', instructions: '?' },
} as const;
declare const definition: DecisionDefinition<typeof questions>;
async function check() {
  const inline = await ai.decide({ state: 'x', questions });
  const label: 'billing' | 'support' = inline.answers.team.choice;
  const probability: number = inline.answers.p.probability;
  const named = await ai.decide({ state: 'x', decision: definition });
  const namedLabel: 'billing' | 'support' = named.answers.team.choice;
  const labels: string[] = await ai.classify({
    text: 'Refund please',
    labels: ['billing', 'support'],
    provider: 'typesafe',
    model: 'jev-1.13.0',
    threshold: 0.6,
  });
  // @ts-expect-error Classification thresholds are numeric probabilities.
  ai.classify({ text: 'x', labels: ['billing'], provider: 'laya', threshold: 'high' });
  // @ts-expect-error Unknown answer keys are rejected.
  inline.answers.missing;
  // @ts-expect-error Public questions use probability, not the provider-specific noul type.
  ai.decide({ state: 'x', questions: { bad: { type: 'noul', instructions: '?' } } });
  // @ts-expect-error Supply a contract or questions, never both.
  ai.decide({ state: 'x', questions, decision: definition });
  return { label, probability, namedLabel, labels };
}
void check;
