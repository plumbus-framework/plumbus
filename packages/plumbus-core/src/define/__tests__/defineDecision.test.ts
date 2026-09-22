import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { choice, noul, score } from '../../ai/decision.js';
import { defineDecision } from '../defineDecision.js';

describe('defineDecision', () => {
  it('returns a deeply frozen contract', () => {
    const decision = defineDecision({
      name: 'support.triage',
      questions: { isUrgent: noul('Urgent?') },
    });

    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.questions)).toBe(true);
    expect(decision.name).toBe('support.triage');
  });

  it('keeps the Zod state schema usable after freezing', () => {
    const decision = defineDecision({
      name: 'support.triage',
      state: z.object({ message: z.string() }),
      questions: { isUrgent: noul('Urgent?') },
    });

    expect(decision.state?.parse({ message: 'hi' })).toEqual({ message: 'hi' });
  });

  it('requires a name', () => {
    expect(() => defineDecision({ name: '', questions: { isUrgent: noul('Urgent?') } })).toThrow(
      /name is required/,
    );
  });

  it('rejects a non-Zod state', () => {
    expect(() =>
      defineDecision({
        name: 'support.triage',
        state: { message: 'string' } as never,
        questions: { isUrgent: noul('Urgent?') },
      }),
    ).toThrow(/state must be a Zod schema/);
  });

  it('requires at least one question', () => {
    expect(() => defineDecision({ name: 'support.triage', questions: {} })).toThrow(
      /at least one question/,
    );
  });

  it('rejects a question with no instructions', () => {
    expect(() =>
      defineDecision({
        name: 'support.triage',
        questions: { isUrgent: { type: 'noul', instructions: '' } },
      }),
    ).toThrow(/instructions are required/);
  });

  it('rejects a choice with fewer than two options', () => {
    expect(() =>
      defineDecision({
        name: 'support.triage',
        questions: { team: choice('Which team?', { billing: null }) },
      }),
    ).toThrow(/at least 2 options/);
  });

  it('rejects a choice over the 255-option limit', () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`option_${i}`, null]),
    );

    expect(() =>
      defineDecision({
        name: 'support.triage',
        questions: { team: choice('Which team?', criteria) },
      }),
    ).toThrow(/at most 255 options, got 256/);
  });

  it('rejects a score outside the 2 to 10 level range', () => {
    expect(() =>
      defineDecision({
        name: 'support.triage',
        questions: { rating: score('Rate it', ['only one']) },
      }),
    ).toThrow(/between 2 and 10 levels, got 1/);

    expect(() =>
      defineDecision({
        name: 'support.triage',
        questions: {
          rating: score(
            'Rate it',
            Array.from({ length: 11 }, (_, i) => `level ${i}`),
          ),
        },
      }),
    ).toThrow(/between 2 and 10 levels, got 11/);
  });

  it('names the failing decision in the error message', () => {
    expect(() =>
      defineDecision({
        name: 'support.triage',
        questions: { team: choice('Which team?', { billing: null }) },
      }),
    ).toThrow(/Decision "support\.triage"/);
  });
});
