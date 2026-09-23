import { describe, expect, it } from 'vitest';
import { parseDecisionResponse, toSystemOneQuestions, validateDecisionRequest } from '../index.js';

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
