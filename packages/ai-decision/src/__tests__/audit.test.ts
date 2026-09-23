import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createDecisionHttpTransport,
  parseDecisionResponse,
  validateDecisionRequest,
} from '../index.js';

const questions = {
  q: { type: 'choice', instructions: '?', criteria: { yes: null, no: null } },
} as const;
const scoreQuestions = {
  q: { type: 'score', instructions: '?', criteria: ['Low', 'High'] },
} as const;
const wire = () => ({
  model: 'm',
  usage: { input_tokens: 3, output_tokens: 1 },
  answers: {
    q: { type: 'choice', choice: 'yes', probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.5 },
  },
});
const postWith = (fetch: typeof globalThis.fetch, config = {}) =>
  createDecisionHttpTransport('audit', { baseUrl: 'https://example.test/v1', fetch, ...config });

describe('shared decision audit', () => {
  it('[S01] rejects fake abort signals at the request boundary', () => {
    expect(() =>
      validateDecisionRequest({ state: '', questions, signal: {} as AbortSignal }, 'audit'),
    ).toThrow(expect.objectContaining({ kind: 'invalid_request' }));
  });
  it('[S02] rejects a __proto__ JSON field rather than silently dropping user state', () => {
    expect(() =>
      validateDecisionRequest(
        { state: JSON.parse('{"__proto__":{"text":"important"}}'), questions },
        'audit',
      ),
    ).toThrow();
  });
  it('[S03] rejects inherited choice labels', () => {
    const result = wire();
    result.answers.q.choice = 'toString';
    expect(() => parseDecisionResponse(result, questions, 'audit')).toThrow();
  });
  it('[S04] rejects an ordinal score inconsistent with its distribution', () => {
    expect(() =>
      parseDecisionResponse(
        {
          ...wire(),
          answers: {
            q: {
              type: 'score',
              score: 0,
              probabilities: { '0': 0, '1': 1 },
              legend: { '0': 'Low', '1': 'High' },
              confidence: 1,
            },
          },
        },
        scoreQuestions,
        'audit',
      ),
    ).toThrow();
  });
  it('[S05] preserves known billed usage when the answers container is malformed', () => {
    expect(() => parseDecisionResponse({ ...wire(), answers: [] }, questions, 'audit')).toThrow(
      expect.objectContaining({
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        model: 'm',
      }),
    );
  });
  it('[S06] rejects whitespace-only response model IDs', () => {
    expect(() => parseDecisionResponse({ ...wire(), model: '  ' }, questions, 'audit')).toThrow();
  });
  it('[S07] rejects unsafe token sums even if the individual counts are safe', () => {
    expect(() =>
      parseDecisionResponse(
        { ...wire(), usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } },
        questions,
        'audit',
      ),
    ).toThrow();
  });
  it('[S08] rejects invalid UTF-8 instead of inserting replacement characters', async () => {
    const body = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
    await expect(postWith(async () => new Response(body))({})).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
  it('[S09] enforces deadlines even when an injected fetch ignores AbortSignal', async () => {
    const pending = postWith(() => new Promise<Response>(() => undefined), { timeoutMs: 15 })(
      {},
    ).catch((e: unknown) => e);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sentinel = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'hung' }), 150);
    });
    try {
      expect(await Promise.race([pending, sentinel])).toMatchObject({ kind: 'timeout' });
    } finally {
      clearTimeout(timer);
    }
  });
  it('[S10] ignores failures while disposing an HTTP error body', async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error('private transport detail');
      },
    });
    await expect(
      postWith(async () => new Response(body, { status: 401 }))({}),
    ).rejects.toMatchObject({ kind: 'http', httpStatus: 401 });
  });
  it('[S11] treats negative Retry-After as invalid and uses backoff', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '-1' } }))
      .mockResolvedValueOnce(Response.json({}));
    await expect(postWith(fetch, { timeoutMs: 30 })({})).rejects.toMatchObject({ kind: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('[S12] normalizes repeated trailing slashes in reverse-proxy prefixes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
    await postWith(fetch, { baseUrl: 'https://example.test/proxy/v1///' })({});
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://example.test/proxy/v1/systemone');
  });
  it('[S13] rejects class instances instead of copying inherited enumerable fields', () => {
    class State {
      own = 'value';
    }
    Object.defineProperty(State.prototype, 'inherited', { value: 'hidden', enumerable: true });
    expect(() =>
      validateDecisionRequest({ state: new State() as never, questions }, 'audit'),
    ).toThrow();
  });
  it('[S14] preserves null-prototype JSON records', () => {
    const state = Object.assign(Object.create(null), { text: 'שלום' });
    expect(validateDecisionRequest({ state, questions }, 'audit').state).toEqual({ text: 'שלום' });
  });
  it('[S15] rejects sparse arrays instead of converting holes to null', () => {
    expect(() => validateDecisionRequest({ state: new Array(2), questions }, 'audit')).toThrow();
  });
  it('[S16] rejects unserializable low-level request bodies as invalid requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const body: any = {};
    body.self = body;
    await expect(postWith(fetch)(body)).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('[S17] rejects unsupported fetch injection at construction', () => {
    expect(() => postWith(42 as never)).toThrow(expect.objectContaining({ kind: 'configuration' }));
  });
  it('[S18] counts UTF-8 request bytes rather than JavaScript character length', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(postWith(fetch)({ text: 'ש'.repeat(1_100_000) })).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('[S19] applies response limits after HTTP gzip decompression', async () => {
    const compressed = gzipSync(JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(compressed);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') return expect.fail();
    try {
      await expect(
        createDecisionHttpTransport('audit', { baseUrl: `http://127.0.0.1:${address.port}/v1` })(
          {},
        ),
      ).rejects.toMatchObject({ kind: 'invalid_response' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('[S20] accepts tied choices and preserves zero confidence', () => {
    const result = wire();
    result.answers.q.probabilities = { yes: 0.5, no: 0.5 };
    result.answers.q.confidence = 0;
    expect(parseDecisionResponse(result, questions, 'audit').answers.q.confidence).toBe(0);
  });
});
