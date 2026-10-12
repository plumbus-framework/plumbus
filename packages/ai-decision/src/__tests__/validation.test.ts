import { describe, expect, it, vi } from 'vitest';
import {
  parseDecisionResponse,
  runDecision,
  toSystemOneQuestions,
  validateDecisionRequest,
  validateDecisionResult,
  type DecisionProviderAdapter,
} from '../index.js';

const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: null, support: 'Technical help' },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent?',
    criteria: ['Normal', 'Urgent', 'Critical'],
  },
  refund: { type: 'probability', instructions: 'Is a refund requested?' },
} as const;

function response() {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 120, output_tokens: 20 },
    answers: {
      department: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.9, support: 0.1 },
        confidence: 0.7,
      },
      urgency: {
        type: 'score',
        score: 1.2,
        probabilities: { '0': 0, '1': 0.8, '2': 0.2 },
        legend: { '0': 'Normal', '1': 'Urgent', '2': 'Critical' },
        confidence: 0.65,
      },
      refund: { type: 'noul', noul: 0.8 },
    },
  };
}

describe('decision protocol', () => {
  it('preserves structured state, instructions, and descriptions', () => {
    const request = validateDecisionRequest(
      { state: { message: 'החזר בבקשה', items: [1, true, null] }, questions },
      'test',
    );
    expect(request.questions).toEqual(questions);
    expect(request.questions).not.toBe(questions);
    expect(toSystemOneQuestions(request.questions).refund).toEqual({
      type: 'noul',
      instructions: 'Is a refund requested?',
    });
    expect(questions.refund.type).toBe('probability');
  });

  it('normalizes all three answer types without inventing probability confidence', () => {
    const result = parseDecisionResponse(response(), questions, 'typesafe');
    expect(result.answers.refund).toEqual({ type: 'probability', probability: 0.8 });
    expect(result.answers.department.confidence).toBe(0.7);
    expect(result.answers.urgency.score).toBe(1.2);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 20, totalTokens: 140 });
  });

  it.each([
    [
      'extra answer',
      (r: any) => {
        r.answers.extra = r.answers.refund;
      },
    ],
    [
      'missing answer',
      (r: any) => {
        delete r.answers.refund;
      },
    ],
    [
      'wrong type',
      (r: any) => {
        r.answers.refund = r.answers.department;
      },
    ],
    [
      'unknown label',
      (r: any) => {
        r.answers.department.choice = 'sales';
      },
    ],
    [
      'not highest probability',
      (r: any) => {
        r.answers.department.choice = 'support';
      },
    ],
    [
      'missing probability',
      (r: any) => {
        delete r.answers.department.probabilities.support;
      },
    ],
    [
      'extra probability',
      (r: any) => {
        r.answers.department.probabilities.extra = 0;
      },
    ],
    [
      'distribution sum',
      (r: any) => {
        r.answers.department.probabilities.billing = 0.2;
      },
    ],
    [
      'negative probability',
      (r: any) => {
        r.answers.refund.noul = -0.1;
      },
    ],
    [
      'nonfinite probability',
      (r: any) => {
        r.answers.refund.noul = Number.NaN;
      },
    ],
    [
      'invalid confidence',
      (r: any) => {
        r.answers.department.confidence = 2;
      },
    ],
    [
      'out of range score',
      (r: any) => {
        r.answers.urgency.score = 3;
      },
    ],
    [
      'missing score level',
      (r: any) => {
        delete r.answers.urgency.legend['0'];
      },
    ],
  ])('rejects %s and preserves known billable usage', (_name, mutate) => {
    const wire = response();
    mutate(wire);
    expect(() => parseDecisionResponse(wire, questions, 'test')).toThrow(
      expect.objectContaining({
        kind: 'invalid_response',
        model: 'jev-1.13.0',
        usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
      }),
    );
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid token usage %s', (count) => {
    const wire = response();
    wire.usage.input_tokens = count;
    expect(() => parseDecisionResponse(wire, questions, 'test')).toThrow();
  });

  it('accepts four-decimal rounded distributions and strips provider action predictions', () => {
    const q = {
      a: { type: 'choice', instructions: 'Pick', criteria: { a: null, b: null, c: null } },
    } as const;
    const wire = {
      model: 'laya',
      usage: { input_tokens: 2, output_tokens: 0 },
      answers: {
        a: {
          type: 'choice',
          choice: 'a',
          probabilities: { a: 0.3333, b: 0.3333, c: 0.3333 },
          confidence: 0,
          action: 'execute',
        },
      },
    };
    expect(parseDecisionResponse(wire, q, 'laya').answers.a).not.toHaveProperty('action');
  });

  it('widens the numeric checks only for a declared rounding step', async () => {
    const wire = response();
    wire.answers.department.probabilities = { billing: 0.5, support: 0.49 };
    wire.answers.urgency.score = 1.19;
    expect(() => parseDecisionResponse(wire, questions, 'test')).toThrow(
      expect.objectContaining({ kind: 'invalid_response' }),
    );
    const parsed = parseDecisionResponse(wire, questions, 'test', { rounding: 0.01 });
    expect(parsed.answers.department.probabilities).toEqual({ billing: 0.5, support: 0.49 });
    for (const rounding of [0, 0.1, Number.NaN]) {
      expect(() => parseDecisionResponse(wire, questions, 'test', { rounding })).toThrow(
        expect.objectContaining({ kind: 'configuration' }),
      );
      expect(() => validateDecisionResult({}, questions, 'test', { rounding })).toThrow(
        expect.objectContaining({ kind: 'configuration' }),
      );
    }

    const run = (rounding?: number) => {
      const decide = vi.fn(async () => ({
        ...parsed,
        cost: null,
        costAvailable: false,
        latencyMs: 0,
      }));
      const providers = { test: { name: 'test', rounding, decide } as DecisionProviderAdapter };
      const hooks = {
        secure: (input: Record<string, unknown>) => input,
        checkBudget() {},
        async record() {},
      };
      return {
        decide,
        result: runDecision(
          { state: 'text', questions },
          { providers, defaultProvider: 'test' },
          hooks,
        ),
      };
    };
    await expect(run(0.01).result).resolves.toMatchObject({ answers: parsed.answers });
    await expect(run().result).rejects.toMatchObject({ kind: 'invalid_response' });
    const invalid = run(0.5);
    await expect(invalid.result).rejects.toMatchObject({ kind: 'configuration' });
    expect(invalid.decide).not.toHaveBeenCalled();
  });

  it('caps a declared rounding allowance for choices with many options', () => {
    const keys = Array.from({ length: 255 }, (_, i) => `o${i}`);
    const criteria = Object.fromEntries(keys.map((key) => [key, null]));
    const q = { a: { type: 'choice' as const, instructions: 'Pick', criteria } };
    const zeros = Object.fromEntries(keys.map((key) => [key, 0]));
    const wire = (top: number) => ({
      model: 'm',
      usage: { input_tokens: 2, output_tokens: 0 },
      answers: {
        a: { type: 'choice', choice: 'o0', probabilities: { ...zeros, o0: top }, confidence: 0 },
      },
    });
    expect(parseDecisionResponse(wire(0.96), q, 'test', { rounding: 0.01 }).answers.a.choice).toBe(
      'o0',
    );
    for (const top of [0, 0.5, 0.9])
      expect(() => parseDecisionResponse(wire(top), q, 'test', { rounding: 0.01 })).toThrow(
        expect.objectContaining({ kind: 'invalid_response' }),
      );
  });

  it.each([
    { state: 'text', questions: {} },
    { state: null, questions },
    { state: 'text', questions, timeoutMs: 0 },
    {
      state: 'text',
      questions: { a: { type: 'choice', instructions: '?', criteria: { only: null } } },
    },
    { state: 'text', questions: { a: { type: 'score', instructions: '?', criteria: ['one'] } } },
    { state: 'text', questions: { a: { type: 'noul', instructions: '?' } } },
  ])('rejects malformed requests', (request) => {
    expect(() => validateDecisionRequest(request as never, 'test')).toThrow(
      expect.objectContaining({ kind: 'invalid_request' }),
    );
  });

  it('does not leak sensitive input in validation errors, including cycles', () => {
    const cycle: any = { secret: 'private-token' };
    cycle.self = cycle;
    try {
      validateDecisionRequest({ state: cycle, questions }, 'test');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-token');
      return;
    }
    expect.fail('Expected a structured validation failure');
  });
});
