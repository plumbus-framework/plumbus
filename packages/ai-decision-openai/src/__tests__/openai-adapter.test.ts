import { describe, expect, it, vi } from 'vitest';
import { createOpenAIDecisionAdapter, DecisionProviderError } from '../index.js';

const request = {
  state: 'I was charged twice. Please refund the duplicate charge.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team handles this request?',
      criteria: { billing: 'Payments and refunds', technical: 'Software bugs', other: null },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this request?',
      criteria: ['Routine', 'Time sensitive', 'Emergency'],
    },
    refund: {
      type: 'probability',
      instructions: 'Does the customer request a refund?',
      criteria: { true: 'An explicit refund request', false: 'Only a question' },
    },
  },
} as const;

const answers = [
  {
    type: 'choice',
    name: 'department',
    choice: 'billing',
    probabilities: [
      { value: 'billing', probability: 0.95 },
      { value: 'technical', probability: 0.03 },
      { value: 'other', probability: 0.02 },
    ],
    confidence: 0.93,
  },
  {
    type: 'score',
    name: 'urgency',
    score: 1.1,
    probabilities: [
      { value: 0, label: 'Routine', probability: 0.1 },
      { value: 1, label: 'Time sensitive', probability: 0.7 },
      { value: 2, label: 'Emergency', probability: 0.2 },
    ],
    confidence: 0.55,
  },
  { type: 'predicate', name: 'refund', probability: 0.92 },
];
const usage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1000,
};
const wire = { model: 'gpt-6-luna', answers, usage };

function respond(body: unknown) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body));
}

describe('OpenAI decision adapter', () => {
  it('maps questions to the Decisions API and returns typed results with input pricing', async () => {
    const fetch = respond(wire);
    const result = await createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch }).decide(request);

    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.openai.com/v1/decisions');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer sk-test' },
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'gpt-6-luna',
      input: request.state,
      questions: [
        {
          type: 'choice',
          name: 'department',
          instructions: 'Which team handles this request?',
          choices: [
            { value: 'billing', description: 'Payments and refunds' },
            { value: 'technical', description: 'Software bugs' },
            { value: 'other' },
          ],
        },
        {
          type: 'score',
          name: 'urgency',
          instructions: 'How urgent is this request?',
          levels: [{ label: 'Routine' }, { label: 'Time sensitive' }, { label: 'Emergency' }],
        },
        {
          type: 'predicate',
          name: 'refund',
          instructions:
            'Does the customer request a refund?\nTrue when: An explicit refund request\nFalse when: Only a question',
        },
      ],
    });

    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-luna',
      usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
      costAvailable: true,
    });
    expect(result.cost).toBeCloseTo(0.0001, 12);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const department: 'billing' | 'technical' | 'other' = result.answers.department.choice;
    expect(department).toBe('billing');
    expect(result.answers.department).toMatchObject({
      probabilities: { billing: 0.95, technical: 0.03, other: 0.02 },
      confidence: 0.93,
    });
    expect(result.answers.urgency).toEqual({
      type: 'score',
      score: 1.1,
      probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 },
      confidence: 0.55,
      legend: { 0: 'Routine', 1: 'Time sensitive', 2: 'Emergency' },
    });
    expect(result.answers.refund).toEqual({ type: 'probability', probability: 0.92 });
  });

  it('serializes structured state and descriptions as JSON text', async () => {
    const fetch = respond({
      ...wire,
      answers: [{ type: 'predicate', name: 'refund', probability: 0.4 }],
    });
    await createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch }).decide({
      state: { text: 'Refund please', locale: 'en' },
      questions: { refund: { type: 'probability', instructions: { label: 'refund' } } },
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe('{"text":"Refund please","locale":"en"}');
    expect(body.questions[0].instructions).toBe('{"label":"refund"}');
  });

  it('uses model overrides and custom base URLs', async () => {
    const fetch = respond({ ...wire, model: 'gpt-6-luna-preview' });
    const result = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example.test/openai/v1',
      model: 'gpt-6-luna-preview',
      inputRates: { 'gpt-6-luna-preview': 0.2 },
      fetch,
    }).decide(request);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://proxy.example.test/openai/v1/decisions');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe('gpt-6-luna-preview');
    expect(result.cost).toBeCloseTo(0.0002, 12);
  });

  it('prices dated snapshots of a priced model and leaves unknown models unpriced', async () => {
    const dated = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      fetch: respond({ ...wire, model: 'gpt-6-luna-2026-10-01' }),
    }).decide(request);
    expect(dated.cost).toBeCloseTo(0.0001, 12);

    const unknown = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      fetch: respond({ ...wire, model: 'gpt-7-luna' }),
    }).decide(request);
    expect(unknown).toMatchObject({ cost: null, costAvailable: false });
  });

  it('honors a configured zero rate', async () => {
    const result = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      inputRates: { 'gpt-6-luna': 0 },
      fetch: respond(wire),
    }).decide(request);
    expect(result).toMatchObject({ cost: 0, costAvailable: true });
  });

  it('reports refusals as billed invalid responses with usage and cost', async () => {
    const fetch = respond({
      ...wire,
      answers: [answers[0], answers[1], { type: 'refusal', name: 'refund' }],
    });
    const error = await createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch })
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionProviderError);
    expect(error).toMatchObject({
      kind: 'invalid_response',
      model: 'gpt-6-luna',
      usage: { inputTokens: 1000, totalTokens: 1000 },
      message: 'OpenAI refused to answer a decision question',
    });
    expect((error as DecisionProviderError).cost).toBeCloseTo(0.0001, 12);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing answer', answers.slice(0, 2)],
    ['an unknown answer name', [answers[0], answers[1], { ...answers[2], name: 'other' }]],
    ['a duplicate answer', [answers[0], answers[0], answers[2]]],
    ['a mismatched type', [answers[0], answers[1], { ...answers[0], name: 'refund' }]],
    [
      'a choice outside the requested options',
      [{ ...answers[0], choice: 'sales' }, answers[1], answers[2]],
    ],
    [
      'duplicate choice probabilities',
      [
        {
          ...answers[0],
          probabilities: [
            { value: 'billing', probability: 0.5 },
            { value: 'billing', probability: 0.5 },
            { value: 'other', probability: 0 },
          ],
        },
        answers[1],
        answers[2],
      ],
    ],
    [
      'a renamed score level',
      [
        answers[0],
        {
          ...answers[1],
          probabilities: [
            { value: 0, label: 'Low', probability: 0.1 },
            { value: 1, label: 'Time sensitive', probability: 0.7 },
            { value: 2, label: 'Emergency', probability: 0.2 },
          ],
        },
        answers[2],
      ],
    ],
    ['an inconsistent score', [answers[0], { ...answers[1], score: 2 }, answers[2]]],
    ['an out-of-range probability', [answers[0], answers[1], { ...answers[2], probability: 1.5 }]],
  ])('rejects %s while preserving billed usage', async (_case, body) => {
    const fetch = respond({ ...wire, answers: body });
    await expect(
      createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch }).decide(request),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
      model: 'gpt-6-luna',
      usage: { inputTokens: 1000 },
    });
  });

  it('rejects an invalid envelope without inventing usage', async () => {
    const error = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      fetch: respond({ answers }),
    })
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid_response' });
    expect((error as DecisionProviderError).usage).toBeUndefined();
  });

  it('rejects invalid requests before making a billable call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch }).decide({
        ...request,
        questions: {},
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry or expose OpenAI error bodies', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"secret detail"}', { status: 400 }));
    const error = await createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch })
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'http', httpStatus: 400, attempts: 1 });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it.each([
    { apiKey: '' },
    { apiKey: 'sk test' },
    { apiKey: 'sk-test', baseUrl: 'https://user:pass@api.openai.com/v1' },
    { apiKey: 'sk-test', inputRates: { model: -1 } },
    { apiKey: 'sk-test', inputRates: { model: Number.NaN } },
  ])('rejects invalid configuration %#', (config) => {
    expect(() => createOpenAIDecisionAdapter(config)).toThrow(
      expect.objectContaining({ kind: 'configuration' }),
    );
  });
});
