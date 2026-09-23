import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createTypeSafeDecisionAdapter } from '../index.js';

const request = {
  state: 'שלום',
  questions: {
    p: {
      type: 'probability',
      instructions: 'Refund?',
      criteria: { true: 'Refund asked', false: 'No refund' },
    },
  },
} as const;
const wire = () => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 100, output_tokens: 10 },
  answers: { p: { type: 'noul', noul: 0 } },
});
const client = (fetch: typeof globalThis.fetch, extra = {}) =>
  createTypeSafeDecisionAdapter({ apiKey: 'key', fetch, ...extra });
async function withServer(handler: RequestListener, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') return expect.fail();
  try {
    await run(`http://127.0.0.1:${address.port}/proxy/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('TypeSafe API audit', () => {
  it('[T01] rejects whitespace-corrupted keys rather than silently changing credentials', () => {
    expect(() => createTypeSafeDecisionAdapter({ apiKey: ' key\n' })).toThrow();
  });
  it('[T02] rejects keys with non-ASCII header characters before network IO', () => {
    expect(() => createTypeSafeDecisionAdapter({ apiKey: 'key-ש' })).toThrow();
  });
  it('[T03] rejects an explicit null endpoint instead of silently using production', () => {
    expect(() =>
      createTypeSafeDecisionAdapter({ apiKey: 'key', baseUrl: null as never }),
    ).toThrow();
  });
  it('[T04] computes large finite estimates without intermediate multiplication overflow', async () => {
    const data = wire();
    data.usage.input_tokens = 100_000;
    const result = await client(async () => Response.json(data), {
      inputRates: { 'jev-1.13.0': 1e304 },
    }).decide(request);
    expect(result.cost).toBeCloseTo(1e303, -290);
  });
  it('[T05] retains model/usage if the final cost cannot be represented', async () => {
    const data = wire();
    data.usage.input_tokens = 2_000_000;
    await expect(
      client(async () => Response.json(data), {
        inputRates: { 'jev-1.13.0': Number.MAX_VALUE },
      }).decide(request),
    ).rejects.toMatchObject({
      usage: { inputTokens: 2_000_000, outputTokens: 10, totalTokens: 2_000_010 },
      model: 'jev-1.13.0',
    });
  });
  it('[T06] sends structured instructions and native true/false criteria unchanged', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(wire()));
    await client(fetch).decide({
      ...request,
      questions: {
        p: { ...request.questions.p, instructions: { rule: 'Refund?', examples: ['yes', 'no'] } },
      },
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.questions.p).toEqual({
      type: 'noul',
      instructions: { rule: 'Refund?', examples: ['yes', 'no'] },
      criteria: request.questions.p.criteria,
    });
  });
  it('[T07] accepts the documented 255-choice boundary and rejects 256 without billing', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`c${i}`, null]));
    const probabilities = Object.fromEntries(
      Object.keys(criteria).map((k) => [k, k === 'c0' ? 1 : 0]),
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        ...wire(),
        answers: { q: { type: 'choice', choice: 'c0', probabilities, confidence: 1 } },
      }),
    );
    const adapter = client(fetch);
    await adapter.decide({
      state: '',
      questions: { q: { type: 'choice', instructions: '?', criteria } },
    });
    await expect(
      adapter.decide({
        state: '',
        questions: {
          q: { type: 'choice', instructions: '?', criteria: { ...criteria, extra: null } },
        },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('[T08] accepts ten score levels and rejects eleven', async () => {
    const criteria = Array.from({ length: 10 }, (_, i) => `Level ${i}`);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        ...wire(),
        answers: {
          q: {
            type: 'score',
            score: 9,
            probabilities: Object.fromEntries(criteria.map((_, i) => [i, i === 9 ? 1 : 0])),
            legend: Object.fromEntries(criteria.map((v, i) => [i, v])),
            confidence: 1,
          },
        },
      }),
    );
    const adapter = client(fetch);
    await adapter.decide({
      state: '',
      questions: { q: { type: 'score', instructions: '?', criteria } },
    });
    await expect(
      adapter.decide({
        state: '',
        questions: { q: { type: 'score', instructions: '?', criteria: [...criteria, 'Eleven'] } },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
  });
  it('[T09] snapshots configuration so later mutation cannot change billing', async () => {
    const rates = { 'jev-1.13.0': 1 };
    const adapter = client(async () => Response.json(wire()), { inputRates: rates });
    rates['jev-1.13.0'] = 999;
    expect((await adapter.decide(request)).cost).toBe(0.0001);
  });
  it('[T10] preserves a zero probability and absent confidence', async () => {
    expect((await client(async () => Response.json(wire())).decide(request)).answers.p).toEqual({
      type: 'probability',
      probability: 0,
    });
  });
  it('[T11] never resolves model pricing from an object prototype', async () => {
    expect(
      await client(async () => Response.json({ ...wire(), model: 'toString' })).decide(request),
    ).toMatchObject({ cost: null, costAvailable: false });
  });
  it('[T12] sends independent credentials for concurrent adapters over real HTTP', async () => {
    const keys: string[] = [];
    await withServer(
      (req, res) => {
        keys.push(req.headers.authorization ?? '');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(wire()));
      },
      async (baseUrl) => {
        await Promise.all(
          ['a', 'b'].map((apiKey) =>
            createTypeSafeDecisionAdapter({ apiKey, baseUrl }).decide(request),
          ),
        );
      },
    );
    expect(keys.sort()).toEqual(['Bearer a', 'Bearer b']);
  });
  it('[T13] recovers from a real 529 response and resends the same body', async () => {
    const bodies: string[] = [];
    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (b: Buffer) => chunks.push(b));
        req.on('end', () => {
          bodies.push(Buffer.concat(chunks).toString());
          if (bodies.length === 1) {
            res.writeHead(529, { 'Retry-After': '0' });
            res.end('overloaded');
          } else res.end(JSON.stringify(wire()));
        });
      },
      async (baseUrl) => {
        expect(
          (await createTypeSafeDecisionAdapter({ apiKey: 'key', baseUrl }).decide(request)).answers
            .p.probability,
        ).toBe(0);
      },
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });
  it('[T14] refuses redirects without forwarding the bearer key', async () => {
    let followed = 0;
    await withServer(
      (_req, res) => {
        followed += 1;
        res.end(JSON.stringify(wire()));
      },
      async (destination) => {
        await withServer(
          (_req, res) => {
            res.writeHead(307, { location: `${destination}/systemone` });
            res.end();
          },
          async (baseUrl) => {
            await expect(
              createTypeSafeDecisionAdapter({ apiKey: 'private-key', baseUrl }).decide(request),
            ).rejects.toMatchObject({ kind: 'network' });
          },
        );
      },
    );
    expect(followed).toBe(0);
  });
  it('[T15] does not retry a real validation error or expose its body', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        res.writeHead(422);
        res.end('private submitted text');
      },
      async (baseUrl) => {
        await expect(
          createTypeSafeDecisionAdapter({ apiKey: 'key', baseUrl }).decide(request),
        ).rejects.toMatchObject({
          httpStatus: 422,
          attempts: 1,
          message: 'Decision provider returned HTTP 422',
        });
      },
    );
    expect(calls).toBe(1);
  });
  it('[T16] honors a per-call deadline over a longer adapter default', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.write('{');
      },
      async (baseUrl) => {
        await expect(
          createTypeSafeDecisionAdapter({ apiKey: 'key', baseUrl, timeoutMs: 30_000 }).decide({
            ...request,
            timeoutMs: 30,
          }),
        ).rejects.toMatchObject({ kind: 'timeout' });
      },
    );
  });
});
