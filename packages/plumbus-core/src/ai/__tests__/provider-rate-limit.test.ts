import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIAdapter, ProviderAPIError } from '../provider.js';
import { isCostFreeProviderFailure } from '../provider-failure.js';
import {
  extendProviderCooldown,
  parseRetryAfterMs,
  providerCooldownRemainingMs,
  resetProviderCooldowns,
  waitForProviderCooldown,
} from '../provider-cooldown.js';

const ok = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({
    choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
    model: 'gpt-4o',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }),
});

const tooMany = (
  headers: Record<string, string> = {},
  body = '{"error":{"code":"rate_limit_exceeded"}}',
) => ({
  ok: false,
  status: 429,
  headers: new Headers(headers),
  text: async () => body,
});

/** Settles `promise` into a value or the error it rejected with, so fake timers can run first. */
function settle<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (reason: unknown) => reason,
  );
}

beforeEach(() => {
  resetProviderCooldowns();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetProviderCooldowns();
});

describe('provider cooldowns', () => {
  it('only ever moves a cooldown later', () => {
    extendProviderCooldown('p', 30_000);
    extendProviderCooldown('p', 1_000);
    expect(providerCooldownRemainingMs('p')).toBe(30_000);
    extendProviderCooldown('p', 45_000);
    expect(providerCooldownRemainingMs('p')).toBe(45_000);
  });

  it('reads retry-after-ms, retry-after seconds and retry-after dates', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '20' }))).toBe(20_000);
    const at = new Date(Date.now() + 7_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': at }))).toBeGreaterThan(5_000);
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
  });

  it('refuses at once, without waiting, when the cooldown outlasts the allowed wait', async () => {
    extendProviderCooldown('p', 90_000);
    const gate = await waitForProviderCooldown('p', { maxWaitMs: 60_000 });
    expect(gate).toEqual({ state: 'closed', waitedMs: 0, retryAfterMs: 90_000 });
  });

  it('keeps its jitter inside the allowed wait', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    extendProviderCooldown('p', 60_000);
    const gate = waitForProviderCooldown('p', { maxWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await gate).toEqual({ state: 'open', waitedMs: 60_000 });
    vi.restoreAllMocks();
  });

  it('ends the wait when the caller aborts', async () => {
    extendProviderCooldown('p', 20_000);
    const caller = new AbortController();
    const waiting = settle(
      waitForProviderCooldown('p', { maxWaitMs: 60_000, signal: caller.signal }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(new Error('caller gave up'));
    expect(await waiting).toMatchObject({ message: 'caller gave up' });
  });
});

describe('OpenAI adapter rate limits', () => {
  it('waits the full Retry-After the provider asked for, past the old 5 s cap', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tooMany({ 'retry-after': '20' }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const result = settle(adapter.complete({ prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toMatchObject({ content: 'done' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('pauses every other call to the provider while one is cooling down', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tooMany({ 'retry-after': '10' }))
      .mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const first = settle(adapter.complete({ prompt: 'first' }));
    await vi.advanceTimersByTimeAsync(0);
    const second = settle(adapter.complete({ prompt: 'second' }));
    await vi.advanceTimersByTimeAsync(5_000);
    // The second call has not been sent: it waits behind the first call's 429.
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await first).toMatchObject({ content: 'done' });
    expect(await second).toMatchObject({ content: 'done' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('fails with retryAfterMs, without sending again, when the cooldown is longer than a call waits', async () => {
    const fetch = vi.fn().mockResolvedValue(tooMany({ 'retry-after': '300' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const error = await settle(adapter.complete({ prompt: 'x' }));
    expect(error).toBeInstanceOf(ProviderAPIError);
    expect(error).toMatchObject({ statusCode: 429, retryable: true, attempts: 1 });
    expect((error as ProviderAPIError).retryAfterMs).toBe(300_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry or pause when the account is out of credit', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        tooMany({}, '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}'),
      );
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const error = await settle(adapter.complete({ prompt: 'x' }));
    expect(error).toMatchObject({ statusCode: 429, retryable: false, attempts: 1 });
    expect((error as ProviderAPIError).retryAfterMs).toBeUndefined();
    expect(providerCooldownRemainingMs('openai')).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the caller's signal aborts", async () => {
    const fetch = vi.fn().mockResolvedValue(tooMany({ 'retry-after': '30' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
    const caller = new AbortController();

    const result = settle(adapter.complete({ prompt: 'x', signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(2_000);
    caller.abort(new Error('deadline'));
    const error = await result;
    // Only a free 429 was sent before the gate, so the cancelled call costs nothing.
    expect(error).toMatchObject({
      name: 'ProviderRequestNotSentError',
      cause: { message: 'deadline' },
    });
    expect(isCostFreeProviderFailure(error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("counts a call cancelled at another caller's cooldown, before sending anything, as free", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(tooMany({ 'retry-after': '20' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
    const first = new AbortController();
    const firstResult = settle(adapter.complete({ prompt: 'x', signal: first.signal }));
    await vi.advanceTimersByTimeAsync(0);
    const caller = new AbortController();

    const result = settle(adapter.complete({ prompt: 'x', signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(new DOMException('deadline', 'TimeoutError'));
    const error = await result;
    expect(error).toMatchObject({ name: 'ProviderRequestNotSentError' });
    expect(isCostFreeProviderFailure(error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    first.abort(new Error('done'));
    await firstResult;
  });

  it('keeps charging a cancelled call whose earlier attempt got a 5xx', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => 'busy',
      })
      .mockResolvedValueOnce(tooMany({ 'retry-after': '30' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });
    const caller = new AbortController();
    const other = new AbortController();

    const result = settle(adapter.complete({ prompt: 'x', signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    // Another caller's 429 closes the gate while this call backs off from its 503.
    const otherResult = settle(adapter.complete({ prompt: 'y', signal: other.signal }));
    await vi.advanceTimersByTimeAsync(2_000);
    caller.abort(new Error('deadline'));
    const error = await result;
    expect(error).toMatchObject({ message: 'deadline' });
    expect(isCostFreeProviderFailure(error)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    other.abort(new Error('done'));
    await otherResult;
  });

  it('keeps charging a call stopped by a long cooldown after its 5xx', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => 'busy',
      })
      .mockResolvedValueOnce(tooMany({ 'retry-after': '120' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const result = settle(adapter.complete({ prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    // Another caller's 429 asks for longer than this call may wait.
    const other = settle(adapter.complete({ prompt: 'y' }));
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await result;
    expect(error).toBeInstanceOf(ProviderAPIError);
    expect(error).toMatchObject({ statusCode: 429, retryable: true });
    expect((error as ProviderAPIError).retryAfterMs).toBeGreaterThan(60_000);
    expect(isCostFreeProviderFailure(error)).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    await other;
  });

  it('keeps charging a call that ends on a 4xx after a 5xx', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => 'busy',
      })
      .mockResolvedValueOnce(tooMany({ 'retry-after': '1' }))
      .mockResolvedValueOnce(tooMany({ 'retry-after': '1' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const result = settle(adapter.complete({ prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await result;
    expect(error).toMatchObject({ statusCode: 429 });
    expect(isCostFreeProviderFailure(error)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('still counts a plain 429 with no earlier 5xx as free', async () => {
    const fetch = vi.fn().mockResolvedValue(tooMany({ 'retry-after': '1' }));
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test' });

    const result = settle(adapter.complete({ prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await result;
    expect(error).toMatchObject({ statusCode: 429 });
    expect(isCostFreeProviderFailure(error)).toBe(true);
  });
});

describe('rate-limit scope', () => {
  /** Answers 429 (60 s) to the first request whose body names `limitedModel`, 200 otherwise. */
  function limitOnce(limitedModel: string) {
    let limited = false;
    return vi.fn(async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      if (model === limitedModel && !limited) {
        limited = true;
        return tooMany({ 'retry-after': '60' });
      }
      return ok();
    });
  }

  async function runFor(adapter: ReturnType<typeof createOpenAIAdapter>, model: string) {
    const result = settle(adapter.complete({ prompt: 'x', model }));
    await vi.advanceTimersByTimeAsync(0);
    return result;
  }

  it('pauses calls to the same model on the same account', async () => {
    const fetch = limitOnce('gpt-6-sol');
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-a' });
    const first = runFor(adapter, 'gpt-6-sol');
    await vi.advanceTimersByTimeAsync(100);
    const second = runFor(adapter, 'gpt-6-sol');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not pause another model, another key or another server', async () => {
    const fetch = limitOnce('gpt-6-sol');
    vi.stubGlobal('fetch', fetch);
    const adapter = createOpenAIAdapter({ apiKey: 'sk-a' });
    const limited = runFor(adapter, 'gpt-6-sol');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(runFor(adapter, 'gpt-6-luna')).resolves.toMatchObject({ content: 'done' });
    await expect(
      runFor(createOpenAIAdapter({ apiKey: 'sk-b' }), 'gpt-6-sol'),
    ).resolves.toMatchObject({ content: 'done' });
    await expect(
      runFor(createOpenAIAdapter({ apiKey: 'sk-a', baseUrl: 'http://local:8000/v1' }), 'gpt-6-sol'),
    ).resolves.toMatchObject({ content: 'done' });
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(61_000);
    await limited;
  });
});
