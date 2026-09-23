import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createTypeSafeDecisionAdapter } from '../index.js';

const request = {
  state: 'test',
  questions: { p: { type: 'probability', instructions: '?' } },
} as const;
const wire = () => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 1, output_tokens: 10 },
  answers: { p: { type: 'noul', noul: 0.75 } },
});
const client = (fetch: typeof globalThis.fetch, extra = {}) =>
  createTypeSafeDecisionAdapter({ apiKey: 'key', fetch, ...extra });

describe('TypeSafe audit, round two', () => {
  it('[T17] honors millisecond retry hints', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after-ms': '0' } }))
      .mockResolvedValueOnce(Response.json(wire()));
    await expect(client(fetch, { timeoutMs: 100 }).decide(request)).resolves.toMatchObject({
      provider: 'typesafe',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('[T18] gives retry-after-ms precedence like the official SDK', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 529, headers: { 'retry-after-ms': '0', 'retry-after': '60' } }),
      )
      .mockResolvedValueOnce(Response.json(wire()));
    await expect(client(fetch, { timeoutMs: 100 }).decide(request)).resolves.toMatchObject({
      provider: 'typesafe',
    });
  });
  it('[T19] falls back to Retry-After when the millisecond hint is malformed', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 429,
          headers: { 'retry-after-ms': 'invalid', 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(Response.json(wire()));
    await expect(client(fetch, { timeoutMs: 100 }).decide(request)).resolves.toMatchObject({
      provider: 'typesafe',
    });
  });
  it('[T20] never reports a positive charge that underflows as free', async () => {
    await expect(
      client(async () => Response.json(wire()), {
        inputRates: { 'jev-1.13.0': Number.MIN_VALUE },
      }).decide(request),
    ).rejects.toMatchObject({ kind: 'configuration', usage: { inputTokens: 1 } });
  });
  it('[T21] keeps output tokens free when input usage is zero', async () => {
    const value = wire();
    value.usage.input_tokens = 0;
    expect(await client(async () => Response.json(value)).decide(request)).toMatchObject({
      cost: 0,
      costAvailable: true,
      usage: { outputTokens: 10 },
    });
  });
  it('[T22] rejects a prototype-sensitive pricing override instead of dropping it', () => {
    expect(() =>
      createTypeSafeDecisionAdapter({ apiKey: 'key', inputRates: JSON.parse('{"__proto__":0}') }),
    ).toThrow();
  });
  it('[T23] rejects inherited pricing entries', () => {
    const rates = Object.create({ 'jev-1.13.0': 0 });
    expect(() => createTypeSafeDecisionAdapter({ apiKey: 'key', inputRates: rates })).toThrow();
  });
  it('[T24] validates responses against the snapshot even if callers mutate a pending request', async () => {
    const questions = { p: { type: 'probability' as const, instructions: '?' } };
    let respond: (value: Response) => void = () => undefined;
    const adapter = client(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const pending = adapter.decide({ state: '', questions });
    Object.assign(questions, { extra: questions.p });
    respond(Response.json(wire()));
    expect((await pending).answers.p.probability).toBe(0.75);
  });
  it('[T25] cancelling one concurrent call does not cancel another', async () => {
    const controller = new AbortController();
    const adapter = client(async () => {
      await delay(35);
      return Response.json(wire());
    });
    const cancelled = adapter
      .decide({ ...request, signal: controller.signal })
      .catch((error: unknown) => error);
    const normal = adapter.decide(request);
    controller.abort();
    expect(await cancelled).toMatchObject({ kind: 'cancelled' });
    expect((await normal).answers.p.probability).toBe(0.75);
  });
  it('[T26] rejects HTTP 204 instead of accepting an empty decision', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client(fetch).decide(request)).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('[T27] does not replay a success response whose socket is cut off mid-body', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'Content-Length': 1000 });
      res.write('{');
      res.socket?.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') return expect.fail();
    try {
      await expect(
        createTypeSafeDecisionAdapter({
          apiKey: 'key',
          baseUrl: `http://127.0.0.1:${address.port}`,
        }).decide(request),
      ).rejects.toMatchObject({ kind: 'network', attempts: 1 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(calls).toBe(1);
  });
  it('[T28] compares structured score legends semantically despite object-key order', async () => {
    const criteria = [
      { label: 'Low', rule: 'routine' },
      { label: 'High', rule: 'urgent' },
    ];
    const value = {
      ...wire(),
      answers: {
        q: {
          type: 'score',
          score: 1,
          confidence: 1,
          probabilities: { '0': 0, '1': 1 },
          legend: {
            '0': { rule: 'routine', label: 'Low' },
            '1': { rule: 'urgent', label: 'High' },
          },
        },
      },
    };
    const result = await client(async () => Response.json(value)).decide({
      state: '',
      questions: { q: { type: 'score', instructions: '?', criteria } },
    });
    expect(result.answers.q.legend['1']).toEqual(criteria[1]);
  });
  it('[T29] retains sub-cent precision on normal one-token charges', async () => {
    const result = await client(async () => Response.json(wire())).decide(request);
    expect(result.cost).toBeGreaterThan(0);
    expect(result.cost).toBeCloseTo(0.000000042, 15);
  });
  it('[T30] allows constructor as an explicitly offered choice label', async () => {
    const value = {
      ...wire(),
      answers: {
        q: {
          type: 'choice',
          choice: 'constructor',
          confidence: 1,
          probabilities: { constructor: 1, other: 0 },
        },
      },
    };
    const result = await client(async () => Response.json(value)).decide({
      state: '',
      questions: {
        q: { type: 'choice', instructions: '?', criteria: { constructor: null, other: null } },
      },
    });
    expect(result.answers.q.choice).toBe('constructor');
  });
  it('[T31] uses the actual model rate even if a different rate is configured for its alias', async () => {
    const result = await client(async () => Response.json(wire()), {
      inputRates: { 'jev-latest': 999 },
    }).decide(request);
    expect(result.cost).toBeCloseTo(0.000000042, 15);
  });
});
