import { setTimeout as delay } from 'node:timers/promises';
import { z } from '@plumbus/core/zod';
import { DecisionProviderError } from './errors/index.js';
import type { DecisionHttpConfig } from './types.js';
import { DecisionTimeoutSchema } from './validation.js';

const MaxBodyBytes = 2 * 1024 * 1024;
const RetryStatuses = new Set([429, 500, 502, 503, 504, 529]);
const HttpConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z
    .string()
    .min(1)
    .refine((key) => key.trim() === key && !/[\r\n]/.test(key))
    .optional(),
  timeoutMs: DecisionTimeoutSchema.default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
});

/** Bounded JSON transport shared by the two System One protocol adapters. */
export function createDecisionHttpTransport(provider: string, config: DecisionHttpConfig) {
  const parsed = HttpConfigSchema.safeParse(config);
  if (!parsed.success)
    throw new DecisionProviderError(
      provider,
      'configuration',
      'Invalid decision HTTP configuration',
    );
  const settings = parsed.data;
  const url = new URL(settings.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DecisionProviderError(
      provider,
      'configuration',
      'Use an HTTP(S) base URL without credentials, query, or fragment',
    );
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/systemone`;
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return async (
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> => {
    const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
    if (!DecisionTimeoutSchema.safeParse(timeoutMs).success)
      throw new DecisionProviderError(provider, 'invalid_request', 'Invalid decision deadline');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let attempts = 0;
    try {
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > MaxBodyBytes)
        throw new DecisionProviderError(
          provider,
          'invalid_request',
          'Decision request exceeds 2 MiB',
        );
      for (;;) {
        signal.throwIfAborted();
        attempts += 1;
        const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
          },
          body: serialized,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (RetryStatuses.has(response.status) && attempts <= settings.maxRetries) {
            const retryAfter = response.headers.get('retry-after');
            const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
            const date = retryAfter === null ? Number.NaN : Date.parse(retryAfter);
            const retryMs = Number.isFinite(seconds)
              ? seconds * 1000
              : Number.isFinite(date)
                ? date - Date.now()
                : Math.min(2000, 250 * 2 ** (attempts - 1));
            await delay(Math.min(Math.max(0, retryMs), 2_147_483_647), undefined, { signal });
            continue;
          }
          throw new DecisionProviderError(
            provider,
            'http',
            `Decision provider returned HTTP ${response.status}`,
            { httpStatus: response.status, attempts },
          );
        }
        if (!response.body)
          throw new DecisionProviderError(
            provider,
            'invalid_response',
            'Decision provider returned an empty response',
            { attempts },
          );
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MaxBodyBytes)
              throw new DecisionProviderError(
                provider,
                'invalid_response',
                'Decision response exceeds 2 MiB',
                { attempts },
              );
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new DecisionProviderError(
            provider,
            'invalid_response',
            'Decision provider returned invalid JSON',
            { attempts },
          );
        }
      }
    } catch (error) {
      if (signal.aborted)
        throw new DecisionProviderError(
          provider,
          options.signal?.aborted ? 'cancelled' : 'timeout',
          options.signal?.aborted ? 'Decision request cancelled' : 'Decision request timed out',
          { attempts },
        );
      if (error instanceof DecisionProviderError) throw error;
      throw new DecisionProviderError(provider, 'network', 'Decision provider request failed', {
        attempts,
      });
    }
  };
}
