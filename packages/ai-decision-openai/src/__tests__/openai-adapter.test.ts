import { runDecision, type DecisionQuestion } from '@plumbus/ai-decision';
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
  return vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
}
const choiceWith = (choice: string, ...options: [string, number][]) => ({
  ...answers[0],
  choice,
  probabilities: options.map(([value, probability]) => ({ value, probability })),
});
const scoreWith = (score: number, ...levels: [number, number][]) => ({
  ...answers[1],
  score,
  probabilities: levels.map(([value, probability]) => ({
    value,
    label: request.questions.urgency.criteria[value] ?? 'Unknown',
    probability,
  })),
});

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
      provider: 'openai-decisions',
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
    const adapter = createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example.test/openai/v1',
      model: 'gpt-6-luna-preview',
      inputRates: { 'gpt-6-luna-preview': 0.2 },
      fetch,
    });
    const result = await adapter.decide(request);
    await adapter.decide({ ...request, model: 'gpt-6-luna-next' });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://proxy.example.test/openai/v1/decisions');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe('gpt-6-luna-preview');
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).model).toBe('gpt-6-luna-next');
    expect(result.cost).toBeCloseTo(0.0002, 12);
  });

  it('doubles the bundled rate above 272K input tokens but keeps configured rates flat', async () => {
    const long = { ...wire, usage: { ...usage, input_tokens: 300_000, total_tokens: 300_000 } };
    const bundled = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      fetch: respond(long),
    }).decide(request);
    expect(bundled.cost).toBeCloseTo(0.06, 12);
    const configured = await createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      inputRates: { 'gpt-6-luna': 0.11 },
      fetch: respond(long),
    }).decide(request);
    expect(configured.cost).toBeCloseTo(0.033, 12);
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

  it('never reports a positive charge that underflows as free', async () => {
    await expect(
      createOpenAIDecisionAdapter({
        apiKey: 'sk-test',
        inputRates: { 'gpt-6-luna': Number.MIN_VALUE },
        fetch: respond(wire),
      }).decide(request),
    ).rejects.toMatchObject({ kind: 'configuration', usage: { inputTokens: 1000 } });
  });

  it.each([
    'refund',
    null,
  ])('reports a refusal named %j with the refused question key, usage and cost', async (name) => {
    const fetch = respond({
      ...wire,
      answers: [answers[0], answers[1], { type: 'refusal', name }],
    });
    const error = await createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch })
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionProviderError);
    expect(error).toMatchObject({
      kind: 'invalid_response',
      refusedQuestions: ['refund'],
      model: 'gpt-6-luna',
      usage: { inputTokens: 1000, totalTokens: 1000 },
      message: 'OpenAI refused to answer a decision question',
    });
    expect((error as DecisionProviderError).cost).toBeCloseTo(0.0001, 12);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, DecisionQuestion, object, object]>([
    [
      "the guide's choice example",
      {
        type: 'choice',
        instructions: 'Which team handles this request?',
        criteria: { billing: null, technical: null, shipping: null, other: null },
      },
      choiceWith(
        'billing',
        ['billing', 0.95],
        ['technical', 0.02],
        ['shipping', 0.01],
        ['other', 0.02],
      ),
      { choice: 'billing' },
    ],
    [
      "the guide's score example",
      request.questions.urgency,
      scoreWith(1.1, [0, 0.1], [1, 0.7], [2, 0.2]),
      { score: 1.1 },
    ],
    [
      'two-decimal probabilities that sum to 0.99',
      request.questions.department,
      choiceWith('billing', ['billing', 0.34], ['technical', 0.33], ['other', 0.32]),
      { choice: 'billing', probabilities: { billing: 0.34, technical: 0.33, other: 0.32 } },
    ],
    [
      'a choice tied with the top option within rounding',
      request.questions.department,
      choiceWith('technical', ['billing', 0.34], ['technical', 0.33], ['other', 0.33]),
      { choice: 'technical' },
    ],
    [
      'a score computed before its probabilities were rounded',
      request.questions.urgency,
      scoreWith(1, [0, 0.33], [1, 0.33], [2, 0.34]),
      { score: 1, probabilities: { 0: 0.33, 1: 0.33, 2: 0.34 } },
    ],
    [
      'an omitted zero-probability option',
      request.questions.department,
      choiceWith('billing', ['billing', 0.9], ['technical', 0.1]),
      { probabilities: { billing: 0.9, technical: 0.1, other: 0 } },
    ],
    [
      'an omitted zero-probability level',
      request.questions.urgency,
      scoreWith(0.3, [0, 0.7], [1, 0.3]),
      { score: 0.3, probabilities: { 0: 0.7, 1: 0.3, 2: 0 } },
    ],
  ])('accepts %s through the shared runtime', async (_case, question, answer, expected) => {
    const result = await runDecision(
      { state: request.state, questions: { q: question } },
      {
        providers: {
          'openai-decisions': createOpenAIDecisionAdapter({
            apiKey: 'sk-test',
            fetch: respond({ ...wire, answers: [{ ...answer, name: 'q' }] }),
          }),
        },
        defaultProvider: 'openai-decisions',
      },
      { secure: (input) => input, checkBudget() {}, async record() {} },
    );
    expect(result.answers.q).toMatchObject(expected);
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
      'an unknown choice option',
      [
        choiceWith(
          'billing',
          ['billing', 0.95],
          ['technical', 0.03],
          ['other', 0.02],
          ['sales', 0],
        ),
        answers[1],
        answers[2],
      ],
    ],
    [
      'a repeated choice option',
      [
        choiceWith(
          'billing',
          ['billing', 0.9],
          ['billing', 0.8],
          ['technical', 0.1],
          ['other', 0.1],
        ),
        answers[1],
        answers[2],
      ],
    ],
    [
      'a choice well below the top option',
      [
        choiceWith('billing', ['billing', 0.4], ['technical', 0.45], ['other', 0.15]),
        answers[1],
        answers[2],
      ],
    ],
    [
      'a distribution far from 1',
      [
        choiceWith('billing', ['billing', 0.5], ['technical', 0.2], ['other', 0.1]),
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
    [
      'an unknown score level',
      [answers[0], scoreWith(1.1, [0, 0.1], [1, 0.7], [2, 0.2], [3, 0]), answers[2]],
    ],
    [
      'a repeated score level',
      [answers[0], scoreWith(1.1, [0, 0.1], [1, 0.7], [2, 0.2], [1, 0.7]), answers[2]],
    ],
    ['an inconsistent score', [answers[0], { ...answers[1], score: 2 }, answers[2]]],
    ['an out-of-range probability', [answers[0], answers[1], { ...answers[2], probability: 1.5 }]],
    [
      'a malformed answer next to a refusal',
      [{ ...answers[0], choice: 'sales' }, answers[1], { type: 'refusal', name: 'refund' }],
    ],
  ])('rejects %s while preserving billed usage and cost', async (_case, body) => {
    const fetch = respond({ ...wire, answers: body });
    await expect(
      createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch }).decide(request),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
      model: 'gpt-6-luna',
      usage: { inputTokens: 1000 },
      cost: expect.closeTo(0.0001, 12),
      refusedQuestions: undefined,
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

  it('does not retry a 4xx error or expose its body', async () => {
    const body = { error: { message: 'secret detail', type: 'invalid_request_error', code: null } };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(body, { status: 400 }));
    const error = await createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch })
      .decide(request)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'http', httpStatus: 400, attempts: 1 });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('retries a transient HTTP error through the shared transport', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after-ms': '1' } }))
      .mockResolvedValueOnce(Response.json(wire));
    await expect(
      createOpenAIDecisionAdapter({ apiKey: 'sk-test', fetch }).decide(request),
    ).resolves.toMatchObject({ provider: 'openai-decisions' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forwards per-call deadlines and cancellation to the transport', async () => {
    const adapter = createOpenAIDecisionAdapter({
      apiKey: 'sk-test',
      timeoutMs: 30_000,
      fetch: vi.fn<typeof globalThis.fetch>(() => new Promise(() => {})),
    });
    await expect(adapter.decide({ ...request, timeoutMs: 30 })).rejects.toMatchObject({
      kind: 'timeout',
    });
    const controller = new AbortController();
    const cancelled = adapter.decide({ ...request, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });
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
