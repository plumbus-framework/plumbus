import { choice, noul, score } from '@plumbus/core';
import { APIError, RateLimitError, type TypeSafeClient } from '@typesafe-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createTypeSafeDecisionAdapter, JEV_CAPABILITIES } from '../decision-adapter.js';

type SystemOneArgs = Parameters<TypeSafeClient['systemOne']>;

function stubClient(
  result: unknown,
  options?: { modelsList?: unknown; systemOneError?: unknown },
): { client: TypeSafeClient; calls: SystemOneArgs[] } {
  const calls: SystemOneArgs[] = [];
  const client = {
    systemOne: (...args: SystemOneArgs) => {
      calls.push(args);
      if (options?.systemOneError) return Promise.reject(options.systemOneError);
      return Promise.resolve(result);
    },
    models: {
      list: () => Promise.resolve(options?.modelsList ?? []),
    },
  } as unknown as TypeSafeClient;
  return { client, calls };
}

const noulResult = {
  model: 'jev-1.13.0',
  answers: { isUrgent: { type: 'noul', noul: 0.95 } },
  usage: { input_tokens: 300, output_tokens: 20 },
};

describe('createTypeSafeDecisionAdapter', () => {
  it('declares the limits Jev enforces server-side', () => {
    const adapter = createTypeSafeDecisionAdapter({ client: stubClient(noulResult).client });

    expect(adapter.name).toBe('typesafe');
    expect(adapter.capabilities).toEqual(JEV_CAPABILITIES);
    expect(JEV_CAPABILITIES.maxChoiceOptions).toBe(255);
    expect(JEV_CAPABILITIES.scoreLevels).toEqual({ min: 2, max: 10 });
  });

  it('forwards state, questions and model, and normalizes usage', async () => {
    const { client, calls } = stubClient(noulResult);
    const adapter = createTypeSafeDecisionAdapter({ client });

    const response = await adapter.decide({
      state: 'Help! My payouts have been failing for 3 days.',
      model: 'jev-latest',
      questions: { isUrgent: noul('Does this convey urgency?') },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      state: 'Help! My payouts have been failing for 3 days.',
      model: 'jev-latest',
      questions: { isUrgent: { type: 'noul', instructions: 'Does this convey urgency?' } },
    });

    // The versioned id that answered, not the alias that was sent.
    expect(response.model).toBe('jev-1.13.0');
    expect(response.answers.isUrgent).toEqual({ type: 'noul', noul: 0.95 });
    expect(response.usage).toEqual({ inputTokens: 300, outputTokens: 20, totalTokens: 320 });
  });

  it('prices on input tokens only', async () => {
    const adapter = createTypeSafeDecisionAdapter({
      client: stubClient({ ...noulResult, usage: { input_tokens: 1_000_000, output_tokens: 500 } })
        .client,
    });

    const response = await adapter.decide({
      state: 'x',
      questions: { isUrgent: noul('Urgent?') },
    });

    // $42/Btok is $0.042/MTok, and output tokens are free.
    expect(response.cost).toBeCloseTo(0.042, 6);
  });

  it('omits model when the request does not pin one, letting the SDK default apply', async () => {
    const { client, calls } = stubClient(noulResult);
    const adapter = createTypeSafeDecisionAdapter({ client });

    await adapter.decide({ state: 'x', questions: { isUrgent: noul('Urgent?') } });

    expect(calls[0]?.[0]).not.toHaveProperty('model');
  });

  it('passes an abort signal through to the SDK', async () => {
    const { client, calls } = stubClient(noulResult);
    const adapter = createTypeSafeDecisionAdapter({ client });
    const controller = new AbortController();

    await adapter.decide({
      state: 'x',
      questions: { isUrgent: noul('Urgent?') },
      signal: controller.signal,
    });

    expect(calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('returns choice and score answers unchanged', async () => {
    const adapter = createTypeSafeDecisionAdapter({
      client: stubClient({
        model: 'jev-1.13.0',
        answers: {
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.88, technical: 0.12 },
            confidence: 0.81,
          },
          frustration: {
            type: 'score',
            score: 1.05,
            legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' },
            probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
            confidence: 0.92,
          },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      }).client,
    });

    const { answers } = await adapter.decide({
      state: 'x',
      questions: {
        department: choice('Which team?', { billing: null, technical: null }),
        frustration: score('How frustrated?', ['Calm', 'Frustrated', 'Very angry']),
      },
    });

    expect(answers.department).toMatchObject({ choice: 'billing', confidence: 0.81 });
    expect(answers.frustration).toMatchObject({ score: 1.05, confidence: 0.92 });
  });

  it('rejects a score with too many levels before any network call', async () => {
    const { client, calls } = stubClient(noulResult);
    const adapter = createTypeSafeDecisionAdapter({ client });

    await expect(
      adapter.decide({
        state: 'x',
        questions: {
          rating: score(
            'Rate it',
            Array.from({ length: 11 }, (_, i) => `level ${i}`),
          ),
        },
      }),
    ).rejects.toThrow(/between 2 and 10 levels, got 11/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a request over the 64k combined token budget locally', async () => {
    const { client, calls } = stubClient(noulResult);
    const adapter = createTypeSafeDecisionAdapter({ client });

    await expect(
      adapter.decide({
        state: 'x'.repeat(300_000),
        questions: { isUrgent: noul('Urgent?') },
      }),
    ).rejects.toThrow(/over the 64000-token budget/);
    expect(calls).toHaveLength(0);
  });

  it('maps a rate limit to a retryable provider error', async () => {
    const adapter = createTypeSafeDecisionAdapter({
      client: stubClient(noulResult, {
        systemOneError: new RateLimitError(429, { error: 'slow down' }, new Headers()),
      }).client,
    });

    await expect(
      adapter.decide({ state: 'x', questions: { isUrgent: noul('Urgent?') } }),
    ).rejects.toMatchObject({
      name: 'ProviderAPIError',
      providerName: 'typesafe',
      statusCode: 429,
      retryable: true,
    });
  });

  it('maps a 422 to a non-retryable provider error', async () => {
    const adapter = createTypeSafeDecisionAdapter({
      client: stubClient(noulResult, {
        systemOneError: APIError.fromResponse(422, { error: 'bad question' }, new Headers()),
      }).client,
    });

    await expect(
      adapter.decide({ state: 'x', questions: { isUrgent: noul('Urgent?') } }),
    ).rejects.toMatchObject({ statusCode: 422, retryable: false });
  });

  it('lists models with release metadata', async () => {
    const adapter = createTypeSafeDecisionAdapter({
      client: stubClient(noulResult, {
        modelsList: [
          {
            name: 'jev-latest',
            description: 'Most recent stable release',
            release_date: '2026-09',
          },
        ],
      }).client,
    });

    await expect(adapter.listModels?.()).resolves.toEqual([
      {
        name: 'jev-latest',
        description: 'Most recent stable release',
        releaseDate: '2026-09',
      },
    ]);
  });

  it('returns an empty model list instead of throwing when the endpoint fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      systemOne: () => Promise.resolve(noulResult),
      models: { list: () => Promise.reject(new Error('network down')) },
    } as unknown as TypeSafeClient;

    await expect(createTypeSafeDecisionAdapter({ client }).listModels?.()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
