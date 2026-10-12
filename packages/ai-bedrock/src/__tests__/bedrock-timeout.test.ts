import { describe, expect, it, vi } from 'vitest';
import { createBedrockAdapter } from '../bedrock-adapter.js';
import type { BedrockPricingStore } from '../pricing.js';

const pricing: BedrockPricingStore = {
  warm: vi.fn().mockResolvedValue(undefined),
  getRate: vi.fn().mockReturnValue(undefined),
  listRates: vi.fn().mockReturnValue([]),
  calculateCost: vi.fn().mockReturnValue(undefined),
};

/**
 * Stands in for `BedrockRuntimeClient.send`: answers after `delayMs`, or fails the way the AWS
 * SDK does when `abortSignal` fires first (an `AbortError` whose cause is the signal's reason).
 */
function slowSend(delayMs: number, answer: unknown) {
  return vi.fn(
    (_command: unknown, options: { abortSignal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(answer), delayMs);
        options.abortSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(
              Object.assign(new Error('Request aborted'), {
                name: 'AbortError',
                cause: options.abortSignal.reason,
              }),
            );
          },
          { once: true },
        );
      }),
  );
}

const converseAnswer = {
  output: { message: { role: 'assistant', content: [{ text: 'hello' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function adapterWith(send: unknown, requestTimeout?: number) {
  return createBedrockAdapter({
    region: 'us-east-1',
    pricingStore: pricing,
    runtimeClient: { send } as never,
    warmPricingOnCreate: false,
    ...(requestTimeout === undefined ? {} : { requestTimeout }),
  });
}

describe('Bedrock request timeouts', () => {
  it('fails a request its timeout ended as a non-retryable ProviderAPIError', async () => {
    const adapter = adapterWith(slowSend(60_000, converseAnswer));
    const error = await adapter.complete({ prompt: 'hi', timeout: 100 }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'ProviderAPIError',
      message: 'Bedrock request timed out after 100 ms',
      providerName: 'bedrock',
      retryable: false,
      attempts: 1,
      timeoutMs: 100,
    });
    expect(((error as Error).cause as Error).name).toBe('AbortError');
  });

  it('uses the request timeout over a shorter adapter requestTimeout', async () => {
    const adapter = adapterWith(slowSend(150, converseAnswer), 50);
    const result = await adapter.complete({ prompt: 'hi', timeout: 5_000 });
    expect(result.content).toBe('hello');
  });

  it("rethrows the caller's own abort as raised", async () => {
    const adapter = adapterWith(slowSend(60_000, converseAnswer));
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const error = await adapter
      .complete({ prompt: 'hi', timeout: 5_000, signal: caller.signal })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'AbortError', message: 'Request aborted' });
  });

  /**
   * Stands in for a ConverseStream the timeout cuts off after its first delta: the event stream
   * then either breaks (`ends: 'broken'`, as the SDK's event-stream reader does when its HTTP/2
   * stream is closed) or just ends (`ends: 'quietly'`).
   */
  function cutOffStream(ends: 'broken' | 'quietly') {
    return vi.fn(async (_command: unknown, options: { abortSignal: AbortSignal }) => ({
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hel' } } };
        await new Promise((resolve) =>
          options.abortSignal.addEventListener('abort', resolve, { once: true }),
        );
        if (ends === 'broken')
          throw Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      })(),
    }));
  }

  it.each([
    'broken',
    'quietly',
  ] as const)('reports a stream the timeout cut off mid-answer (event stream ends %s) as the timeout', async (ends) => {
    const adapter = adapterWith(cutOffStream(ends));
    const events = [];
    for await (const event of adapter.stream({ prompt: 'hi', timeout: 100 })) events.push(event);
    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hel' },
      { type: 'error', error: 'Bedrock request timed out after 100 ms' },
    ]);
  });

  it("leaves a stream the caller's abort cut off as before", async () => {
    const adapter = adapterWith(cutOffStream('broken'));
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    const events = [];
    for await (const event of adapter.stream({
      prompt: 'hi',
      timeout: 5_000,
      signal: caller.signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hel' },
      { type: 'error', error: 'Premature close' },
    ]);
  });

  it('reports a stream its timeout ended with the timeout message', async () => {
    const adapter = adapterWith(slowSend(60_000, { stream: [] }));
    const events = [];
    for await (const event of adapter.stream({ prompt: 'hi', timeout: 100 })) events.push(event);
    expect(events).toEqual([{ type: 'error', error: 'Bedrock request timed out after 100 ms' }]);
  });

  const embedAnswer = {
    body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1], inputTextTokenCount: 1 })),
  };

  it('ends an embedding request at its own timeout, as a ProviderAPIError', async () => {
    const adapter = adapterWith(slowSend(60_000, embedAnswer));
    const startedAt = Date.now();
    const error = await adapter.embed({ texts: ['a'], timeout: 100 }).catch((e: unknown) => e);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(error).toMatchObject({
      name: 'ProviderAPIError',
      message: 'Bedrock request timed out after 100 ms',
      providerName: 'bedrock',
      retryable: false,
      timeoutMs: 100,
    });
  });

  it('uses the embedding request timeout over a shorter adapter requestTimeout', async () => {
    const adapter = adapterWith(slowSend(150, embedAnswer), 50);
    const result = await adapter.embed({ texts: ['a'], timeout: 5_000 });
    expect(result.embeddings).toEqual([[0.1]]);
  });

  const timeoutInvalid = { name: 'AIInvalidRequestError', reason: 'timeout_invalid' };

  describe.each([0, -1, 1.5, Number.NaN, 2 ** 31])('an unusable timeout of %s', (timeout) => {
    it('is refused by complete, stream and embed before pricing or Bedrock is called', async () => {
      const send = vi.fn();
      const adapter = adapterWith(send);
      vi.mocked(pricing.warm).mockClear();
      await expect(adapter.complete({ prompt: 'hi', timeout })).rejects.toMatchObject(
        timeoutInvalid,
      );
      await expect(
        (async () => {
          for await (const _event of adapter.stream({ prompt: 'hi', timeout })) {
            // Never reached: the stream refuses the request before its first event.
          }
        })(),
      ).rejects.toMatchObject(timeoutInvalid);
      await expect(adapter.embed({ texts: ['a'], timeout })).rejects.toMatchObject(timeoutInvalid);
      expect(send).not.toHaveBeenCalled();
      expect(pricing.warm).not.toHaveBeenCalled();
    });

    it('is refused as the adapter requestTimeout when a request sets none', async () => {
      const send = vi.fn();
      const adapter = adapterWith(send, timeout);
      await expect(adapter.complete({ prompt: 'hi' })).rejects.toMatchObject(timeoutInvalid);
      await expect(adapter.embed({ texts: ['a'] })).rejects.toMatchObject(timeoutInvalid);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
