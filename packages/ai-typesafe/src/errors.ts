import { ProviderAPIError } from '@plumbus/core';
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeError,
} from '@typesafe-ai/sdk';

export const PROVIDER_NAME = 'typesafe';

/**
 * Translate an SDK error into the framework's provider error.
 *
 * `retryable` drives capability-level retry in core's executor, so it is set
 * only for failures a later attempt could plausibly survive. The SDK has
 * already backed off on 408/429/5xx and honored `retry-after` by the time an
 * error reaches here, so a retryable error means "still failing after the
 * SDK gave up", not "never retried".
 *
 * A caller abort is passed through untouched — turning a deliberate
 * cancellation into a provider failure would make `ctx.signal` look like an
 * outage in the cost ledger.
 */
export function mapTypeSafeError(err: unknown): Error {
  if (err instanceof APIUserAbortError) return err;

  if (err instanceof RateLimitError) {
    const retryAfter =
      err.retryAfterMs != null ? ` (retry after ${Math.ceil(err.retryAfterMs / 1000)}s)` : '';
    return new ProviderAPIError({
      providerName: PROVIDER_NAME,
      message: `TypeSafe rate limit exceeded${retryAfter}: ${err.message}`,
      statusCode: err.status,
      retryable: true,
      attempts: 1,
    });
  }

  if (err instanceof APIError) {
    return new ProviderAPIError({
      providerName: PROVIDER_NAME,
      message: `TypeSafe request failed (${err.status}): ${err.message}`,
      statusCode: err.status,
      // 5xx and 529 Overloaded are transient; 4xx means the request itself is
      // wrong and replaying it changes nothing.
      retryable: err.status >= 500,
      attempts: 1,
    });
  }

  if (err instanceof APIConnectionError) {
    return new ProviderAPIError({
      providerName: PROVIDER_NAME,
      message: `TypeSafe connection failed: ${err.message}`,
      retryable: true,
      attempts: 1,
    });
  }

  if (err instanceof TypeSafeError) {
    return new ProviderAPIError({
      providerName: PROVIDER_NAME,
      message: `TypeSafe request rejected locally: ${err.message}`,
      retryable: false,
      attempts: 1,
    });
  }

  return err instanceof Error ? err : new Error(String(err));
}
