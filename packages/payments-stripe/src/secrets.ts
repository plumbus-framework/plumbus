// ── Secret sources ──
// Secrets are read on first use, never at import: `plumbus generate` and
// migrations import app/payments without Stripe keys present.

import { ErrorCode, PlumbusError } from '@plumbus/core';

/** A value, or a function that returns it (e.g. from a secret manager). */
export type SecretSource<T> = T | (() => T | Promise<T>);

export function lazySecret<T>(source: SecretSource<T>, name: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= Promise.resolve(
      typeof source === 'function' ? (source as () => T | Promise<T>)() : source,
    )
      .then((value) => {
        if (value === undefined || value === null || value === '') {
          throw new PlumbusError(ErrorCode.Internal, `${name} is not configured`, {
            reason: 'payments_secret_missing',
            secret: name,
          });
        }
        return value;
      })
      .catch((err) => {
        cached = undefined;
        throw err;
      });
    return cached;
  };
}

export type StripeKeyMode = 'live' | 'test';

/** Live or test, from the key prefix (`sk_live_`, `rk_test_`, …). */
export function keyMode(key: string): StripeKeyMode {
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  throw new PlumbusError(
    ErrorCode.Validation,
    'STRIPE secret key must start with sk_live_, sk_test_, rk_live_, or rk_test_',
    { reason: 'payments_invalid_stripe_key' },
  );
}
