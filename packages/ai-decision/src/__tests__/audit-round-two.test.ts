import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createDecisionHttpTransport,
  parseDecisionResponse,
  validateDecisionRequest,
} from '../index.js';

const questions = { p: { type: 'probability', instructions: '?' } } as const;
const transport = (fetch: typeof globalThis.fetch, timeoutMs = 1000) =>
  createDecisionHttpTransport('round-two', {
    baseUrl: 'https://example.test/v1',
    fetch,
    timeoutMs,
  });
const deep = () => {
  let value: any = 'end';
  for (let i = 0; i < 70; i++) value = { next: value };
  return value;
};

describe('shared decision audit, round two', () => {
  it('[S21] rejects duplicate top-level response fields', async () => {
    await expect(
      transport(async () => new Response('{"answers":{},"answers":{"p":1}}'))({}),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('[S22] detects duplicate keys after decoding JSON escapes', async () => {
    await expect(
      transport(async () => new Response('{"probabilities":{"yes":0.8,"\\u0079es":0.2}}'))({}),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('[S23] rejects unpaired surrogates before dispatch', () => {
    expect(() =>
      validateDecisionRequest({ state: { text: '\ud800' }, questions }, 'round-two'),
    ).toThrow();
  });
  it('[S24] bounds outbound JSON nesting', () => {
    expect(() => validateDecisionRequest({ state: deep(), questions }, 'round-two')).toThrow();
  });
  it('[S25] bounds nesting even inside unknown response metadata', async () => {
    await expect(
      transport(async () => Response.json({ ignored: deep() }))({}),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('[S26] rejects inherited question fields rather than manufacturing a JSON contract', () => {
    const p = Object.create({ type: 'probability', instructions: '?' });
    expect(() => validateDecisionRequest({ state: '', questions: { p } }, 'round-two')).toThrow();
  });
  it('[S27] rejects score legends that reverse the supplied rubric', () => {
    const q = { s: { type: 'score', instructions: '?', criteria: ['Low', 'High'] } } as const;
    const wire = {
      model: 'm',
      usage: { input_tokens: 1, output_tokens: 0 },
      answers: {
        s: {
          type: 'score',
          score: 1,
          probabilities: { '0': 0, '1': 1 },
          legend: { '0': 'High', '1': 'Low' },
          confidence: 1,
        },
      },
    };
    expect(() => parseDecisionResponse(wire, q, 'round-two')).toThrow();
  });
  it('[S28] preserves the first abort cause when a later caller cancellation races the deadline', async () => {
    const caller = new AbortController();
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      init?.signal?.addEventListener('abort', () => caller.abort('later cancellation'), {
        once: true,
      });
      return new Promise<Response>(() => undefined);
    };
    await expect(transport(fetch, 20)({}, { signal: caller.signal })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
  it('[S29] bounds a stalled reader even when stream cancellation never settles', async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => undefined),
    });
    await expect(transport(async () => new Response(stream), 20)({})).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
  it('[S30] disposes a response that arrives after timeout', async () => {
    const cancel = vi.fn();
    const fetch: typeof globalThis.fetch = async () => {
      await delay(40);
      return new Response(new ReadableStream({ cancel }));
    };
    await expect(transport(fetch, 10)({})).rejects.toMatchObject({ kind: 'timeout' });
    await delay(60);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('[S31] saturates huge Retry-After integers instead of retrying early', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '9'.repeat(400) } }),
      )
      .mockResolvedValueOnce(Response.json({}));
    await expect(transport(fetch, 400)({})).rejects.toMatchObject({ kind: 'timeout' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('[S32] accepts an expired HTTP-date retry hint without delaying a retry', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(transport(fetch, 100)({})).resolves.toEqual({ ok: true });
  });
  it('[S33] decodes UTF-8 code points split across response chunks', async () => {
    const value = {
      text: 'שלום 😀',
      quoted: '{"same":1,"same":2}',
      entries: [{ same: 1 }, { same: 2 }],
      escapes: '"\\\n',
    };
    const bytes = Buffer.from(JSON.stringify(value));
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    await expect(transport(async () => new Response(stream))({})).resolves.toEqual(value);
  });
  it('[S34] clears its deadline timer after successful completion', async () => {
    vi.useFakeTimers();
    try {
      await transport(async () => Response.json({}))({});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('[S35] rejects numeric overflow anywhere in a JSON response', async () => {
    await expect(
      transport(async () => new Response('{"ignored":{"overflow":1e999}}'))({}),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
