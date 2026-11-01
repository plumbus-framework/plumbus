// ── Provider cooldowns ──
// When a provider answers 429 it names how long to stay away. Every call to that provider in
// this process honours the same pause: a cooldown only ever moves later, never earlier, so a
// short hint arriving after a long one cannot shorten the wait the provider asked for.

const cooldowns = new Map<string, number>();

/** Added to each wake-up so callers released together do not all send in the same instant. */
const MAX_JITTER_MS = 250;

/** Milliseconds until `key` may be called again; 0 when it is not cooling down. */
export function providerCooldownRemainingMs(key: string, now: number = Date.now()): number {
  const until = cooldowns.get(key);
  if (until === undefined) return 0;
  if (until <= now) {
    cooldowns.delete(key);
    return 0;
  }
  return until - now;
}

/** Keeps `key` closed for at least `delayMs` from now. An existing later end is kept. */
export function extendProviderCooldown(
  key: string,
  delayMs: number,
  now: number = Date.now(),
): void {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const until = now + delayMs;
  if (until > (cooldowns.get(key) ?? 0)) cooldowns.set(key, until);
}

/** Forgets every cooldown. For tests. */
export function resetProviderCooldowns(): void {
  cooldowns.clear();
}

/**
 * The wait a rate-limit answer asks for, in milliseconds: `retry-after-ms`, else `retry-after`
 * as seconds or an HTTP date. Undefined when neither header is usable.
 */
export function parseRetryAfterMs(headers: {
  get(name: string): string | null;
}): number | undefined {
  const ms = Number(headers.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(at - Date.now(), 0);
}

/**
 * Thrown when the caller cancelled while its request waited at a provider cooldown and nothing of the
 * call had reached the provider. `cause` is the caller's abort reason. Costs nothing: see
 * `isCostFreeProviderFailure`.
 */
export class ProviderRequestNotSentError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ProviderRequestNotSentError';
  }
}

/** Resolves after `delayMs`, or rejects with the signal's reason as soon as it aborts. */
export function sleepUnlessAborted(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type ProviderCooldownWait =
  | { readonly state: 'open'; readonly waitedMs: number }
  /** The cooldown outlasts `maxWaitMs`: nothing was sent, try again after `retryAfterMs`. */
  | { readonly state: 'closed'; readonly waitedMs: number; readonly retryAfterMs: number };

/**
 * Waits until `key` is open. Returns `closed` without waiting at all when the remaining
 * cooldown is longer than `maxWaitMs`, so a caller never sends before the provider's time.
 * Rejects with the signal's reason when `signal` aborts during the wait.
 */
export async function waitForProviderCooldown(
  key: string,
  options: { readonly maxWaitMs: number; readonly signal?: AbortSignal },
): Promise<ProviderCooldownWait> {
  let waitedMs = 0;
  while (true) {
    const remaining = providerCooldownRemainingMs(key);
    if (remaining === 0) return { state: 'open', waitedMs };
    if (remaining > options.maxWaitMs - waitedMs) {
      return { state: 'closed', waitedMs, retryAfterMs: remaining };
    }
    // Jitter stays inside the budget, so a caller never waits longer than it allowed.
    const spare = options.maxWaitMs - waitedMs - remaining;
    const delay = remaining + Math.floor(Math.random() * Math.min(MAX_JITTER_MS, spare));
    const started = Date.now();
    await sleepUnlessAborted(delay, options.signal);
    waitedMs += Date.now() - started;
    // Another 429 may have pushed the end later while this caller slept: check again.
  }
}
