import { setTimeout as delay } from 'node:timers/promises';
import { z } from '@plumbus/core/zod';
import { DecisionProviderError } from './errors/index.js';
import { DecisionJsonSchema, DecisionJsonTextSchema } from './json.js';
import type { DecisionHttpConfig } from './types.js';
import { DecisionSignalSchema, DecisionTimeoutSchema } from './validation.js';

const MaxBodyBytes = 2 * 1024 * 1024;
const RetryStatuses = new Set([429, 500, 502, 503, 504, 529]);
const HttpConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z
    .string()
    .min(1)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
  timeoutMs: DecisionTimeoutSchema.default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  fetch: z.function().optional(),
});

/** Enforce our deadline even if an injected HTTP implementation ignores signal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

function dispose(body: ReadableStream<Uint8Array> | null): void {
  // Cleanup must never replace an HTTP error or hold up the request deadline.
  void body?.cancel().catch(() => undefined);
}

function retryDelay(headers: Headers, attempts: number): number {
  const msHeader = headers.get('retry-after-ms')?.trim() ?? '';
  if (/^\d+(?:\.\d+)?$/.test(msHeader)) return Math.min(Number(msHeader), 2_147_483_647);
  const header = headers.get('retry-after')?.trim() ?? '';
  if (/^\d+$/.test(header)) return Math.min(Number(header) * 1000, 2_147_483_647);
  const date = /^[A-Za-z]{3}/.test(header) ? Date.parse(header) : Number.NaN;
  const ms = Number.isFinite(date) ? date - Date.now() : Math.min(2000, 250 * 2 ** (attempts - 1));
  return Math.min(Math.max(0, ms), 2_147_483_647);
}

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
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/systemone`;
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return async (
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> => {
    const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
    if (
      !DecisionTimeoutSchema.safeParse(timeoutMs).success ||
      !DecisionSignalSchema.safeParse(options.signal).success
    )
      throw new DecisionProviderError(provider, 'invalid_request', 'Invalid decision deadline');
    const deadline = new AbortController();
    const deadlineReason = new DecisionProviderError(
      provider,
      'timeout',
      'Decision request timed out',
    );
    const timer = setTimeout(() => deadline.abort(deadlineReason), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    let attempts = 0;
    try {
      let serialized: string;
      try {
        serialized = z.string().parse(JSON.stringify(DecisionJsonSchema.parse(body)));
      } catch {
        throw new DecisionProviderError(
          provider,
          'invalid_request',
          'Decision request is not serializable JSON',
        );
      }
      if (Buffer.byteLength(serialized) > MaxBodyBytes)
        throw new DecisionProviderError(
          provider,
          'invalid_request',
          'Decision request exceeds 2 MiB',
        );
      for (;;) {
        signal.throwIfAborted();
        attempts += 1;
        const response = await abortable(
          fetchImpl(url, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              'Content-Type': 'application/json',
              ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
            },
            body: serialized,
          }).then((response) => {
            if (signal.aborted) dispose(response.body);
            return response;
          }),
          signal,
        );
        if (!response.ok) {
          dispose(response.body);
          if (RetryStatuses.has(response.status) && attempts <= settings.maxRetries) {
            await delay(retryDelay(response.headers, attempts), undefined, {
              signal,
            });
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
            const next = await abortable(reader.read(), signal);
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
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        try {
          return DecisionJsonTextSchema.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
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
          signal.reason === deadlineReason ? 'timeout' : 'cancelled',
          signal.reason === deadlineReason
            ? 'Decision request timed out'
            : 'Decision request cancelled',
          { attempts },
        );
      if (error instanceof DecisionProviderError) throw error;
      throw new DecisionProviderError(provider, 'network', 'Decision provider request failed', {
        attempts,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
