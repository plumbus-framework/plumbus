import { describe, expect, it, vi } from 'vitest';
import { createBedrockAdapter } from '../bedrock-adapter.js';
import type { BedrockPricingStore } from '../pricing.js';

function pricingStore(): BedrockPricingStore {
  return {
    warm: vi.fn().mockResolvedValue(undefined),
    getRate: vi.fn().mockReturnValue(undefined),
    listRates: vi.fn().mockReturnValue([]),
    calculateCost: vi.fn().mockReturnValue(undefined),
  };
}

const embedAnswer = {
  body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1], inputTextTokenCount: 1 })),
};

/**
 * Stands in for `BedrockRuntimeClient.send`: answers after `delayMs`, or fails the way the AWS
 * SDK does when `abortSignal` fires first (an `AbortError` whose cause is the signal's reason).
 */
function sendAnsweringAfter(delayMs: number) {
  return vi.fn(
    (_command: unknown, options: { abortSignal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        if (options.abortSignal.aborted) {
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
          return;
        }
        const timer = setTimeout(() => resolve(embedAnswer), delayMs);
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

function adapterWith(send: unknown, pricing: BedrockPricingStore, embedConcurrency?: number) {
  return createBedrockAdapter({
    region: 'us-east-1',
    pricingStore: pricing,
    runtimeClient: { send } as never,
    warmPricingOnCreate: false,
    ...(embedConcurrency === undefined ? {} : { embedConcurrency }),
  });
}

describe('Bedrock embed signal', () => {
  it("aborts the in-flight InvokeModel calls when the caller's signal fires", async () => {
    const send = sendAnsweringAfter(60_000);
    const adapter = adapterWith(send, pricingStore());
    const caller = new AbortController();
    const reason = new Error('caller went away');
    setTimeout(() => caller.abort(reason), 20);

    const startedAt = Date.now();
    const error = await adapter
      .embed({ texts: ['a', 'b'], timeout: 10_000, signal: caller.signal })
      .catch((e: unknown) => e);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // As for complete(): the SDK's abort, caused by the caller's reason, not a timeout.
    expect(error).toMatchObject({ name: 'AbortError', message: 'Request aborted' });
    expect((error as Error).cause).toBe(reason);
    const signals = send.mock.calls.map(([, options]) => options.abortSignal);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal.aborted).toBe(true);
  });

  it('sends no further text once the signal has fired', async () => {
    const caller = new AbortController();
    const reason = new Error('cancelled');
    const send = vi.fn(async () => {
      caller.abort(reason); // Fires while the first text is embedded; that call still answers.
      return embedAnswer;
    });
    const adapter = adapterWith(send, pricingStore(), 1);

    await expect(adapter.embed({ texts: ['a', 'b', 'c'], signal: caller.signal })).rejects.toBe(
      reason,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects with a reason that is not an Error as raised, between texts as before the first', async () => {
    const caller = new AbortController();
    const send = vi.fn(async () => {
      caller.abort('user left');
      return embedAnswer;
    });
    const adapter = adapterWith(send, pricingStore(), 1);

    await expect(adapter.embed({ texts: ['a', 'b'], signal: caller.signal })).rejects.toBe(
      'user left',
    );
    await expect(adapter.embed({ texts: ['a'], signal: caller.signal })).rejects.toBe('user left');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('loads no pricing and calls nothing for a signal that already fired', async () => {
    const send = vi.fn();
    const pricing = pricingStore();
    const adapter = adapterWith(send, pricing);
    const reason = new Error('cancelled');

    await expect(adapter.embed({ texts: ['a'], signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect(pricing.warm).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
