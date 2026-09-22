import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createTypeSafeAdapter } from '../classify-adapter.js';

type SystemOneArgs = Parameters<TypeSafeClient['systemOne']>;

/** Answer each generated `label_N` noul with the probability at that index. */
function stubClient(probabilities: number[]): {
  client: TypeSafeClient;
  calls: SystemOneArgs[];
} {
  const calls: SystemOneArgs[] = [];
  const client = {
    systemOne: (...args: SystemOneArgs) => {
      calls.push(args);
      return Promise.resolve({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(
          probabilities.map((noul, index) => [`label_${index}`, { type: 'noul', noul }]),
        ),
        usage: { input_tokens: 250, output_tokens: 0 },
      });
    },
    models: { list: () => Promise.resolve([]) },
  } as unknown as TypeSafeClient;
  return { client, calls };
}

describe('createTypeSafeAdapter', () => {
  it('declares native classify and no generation capabilities', () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([]).client });

    expect(adapter.name).toBe('typesafe');
    expect(adapter.capabilities?.nativeClassify).toBe(true);
    expect(adapter.capabilities?.tools).toBe(false);
    expect(adapter.capabilities?.streamingTools).toBe(false);
  });

  it('asks one noul per label in a single request', async () => {
    const { client, calls } = stubClient([0.9, 0.1, 0.7]);
    const adapter = createTypeSafeAdapter({ client });

    await adapter.classify?.({
      labels: ['billing', 'sales', 'technical'],
      text: 'I was charged twice.',
    });

    expect(calls).toHaveLength(1);
    const request = calls[0]?.[0] as { state: string; questions: Record<string, unknown> };
    expect(request.state).toBe('I was charged twice.');
    expect(Object.keys(request.questions)).toEqual(['label_0', 'label_1', 'label_2']);
    expect(request.questions.label_0).toEqual({
      type: 'noul',
      instructions: { label: 'billing', question: 'Does the `label` apply to the state?' },
      criteria: {
        true: 'The label applies to the state.',
        false: 'The label does not apply to the state.',
      },
    });
  });

  it('keeps labels at or above the threshold, in the requested order', async () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([0.9, 0.1, 0.5]).client });

    const result = await adapter.classify?.({
      labels: ['billing', 'sales', 'technical'],
      text: 'x',
    });

    expect(result?.labels).toEqual(['billing', 'technical']);
  });

  it('honors a custom label threshold', async () => {
    const adapter = createTypeSafeAdapter({
      client: stubClient([0.9, 0.1, 0.5]).client,
      labelThreshold: 0.8,
    });

    const result = await adapter.classify?.({
      labels: ['billing', 'sales', 'technical'],
      text: 'x',
    });

    expect(result?.labels).toEqual(['billing']);
  });

  it('returns no labels when nothing clears the threshold', async () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([0.2, 0.1]).client });

    const result = await adapter.classify?.({ labels: ['billing', 'sales'], text: 'x' });

    expect(result?.labels).toEqual([]);
  });

  it('reports usage and input-only cost', async () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([0.9]).client });

    const result = await adapter.classify?.({ labels: ['billing'], text: 'x' });

    expect(result?.usage).toEqual({ inputTokens: 250, outputTokens: 0, totalTokens: 250 });
    expect(result?.cost).toBeCloseTo((250 / 1_000_000) * 0.042, 12);
  });

  it('handles labels that are not valid identifiers', async () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([0.9, 0.9]).client });

    const result = await adapter.classify?.({
      labels: ['needs human review', 'p1/urgent'],
      text: 'x',
    });

    expect(result?.labels).toEqual(['needs human review', 'p1/urgent']);
  });

  it('rejects an empty label set', async () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([]).client });

    await expect(adapter.classify?.({ labels: [], text: 'x' })).rejects.toThrow(
      /at least one label/,
    );
  });

  it('rejects generation with a message that names the supported surface', async () => {
    const adapter = createTypeSafeAdapter({ client: stubClient([]).client });

    await expect(adapter.complete({ prompt: 'write a poem' })).rejects.toThrow(
      /ctx\.ai\.decide\(\)/,
    );
    await expect(adapter.embed({ texts: ['x'] })).rejects.toThrow(/does not support embeddings/);

    const stream = adapter.stream({ prompt: 'x' })[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow(/does not support streaming/);
  });

  it('reports models only under the decision kind', async () => {
    const client = {
      systemOne: () => Promise.resolve({}),
      models: {
        list: () =>
          Promise.resolve([
            { name: 'jev-latest', description: 'Flagship', release_date: '2026-09' },
          ]),
      },
    } as unknown as TypeSafeClient;
    const adapter = createTypeSafeAdapter({ client });

    await expect(adapter.listModels?.({ kind: 'text' })).resolves.toEqual([]);
    await expect(adapter.listModels?.({ kind: 'decision' })).resolves.toEqual([
      {
        id: 'jev-latest',
        provider: 'typesafe',
        kind: 'decision',
        inputPerMTok: 0.042,
        outputPerMTok: 0,
        displayName: 'Flagship',
        createdAt: '2026-09',
      },
    ]);
  });
});
