// ── Stripe errors → Plumbus errors ──
// Capabilities surface provider failures to sellers, so Stripe's message and
// codes are kept (e.g. "Amount must be at least $0.50 usd") while the error
// becomes a structured PlumbusError the HTTP layer maps to a status.

import { ErrorCode, PlumbusError } from '@plumbus/core';
import Stripe from 'stripe';

export function translateStripeError(err: unknown): unknown {
  if (!(err instanceof Stripe.errors.StripeError)) return err;
  const metadata = {
    reason: 'stripe_error',
    stripeType: err.type,
    ...(err.code ? { stripeCode: err.code } : {}),
    ...(err.param ? { param: err.param } : {}),
    ...(err.requestId ? { requestId: err.requestId } : {}),
    ...(err.statusCode ? { statusCode: err.statusCode } : {}),
  };
  switch (err.type) {
    case 'StripeInvalidRequestError':
    case 'StripeCardError':
      return new PlumbusError(ErrorCode.Validation, err.message, metadata);
    case 'StripeIdempotencyError':
      return new PlumbusError(ErrorCode.Conflict, err.message, metadata);
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
      return new PlumbusError(
        ErrorCode.Internal,
        `Stripe rejected the platform credentials: ${err.message}`,
        metadata,
      );
    default:
      return new PlumbusError(ErrorCode.Internal, `Stripe request failed: ${err.message}`, {
        ...metadata,
        retryable: true,
      });
  }
}

/** Wrap an async provider method so Stripe errors come out as PlumbusErrors. */
export function withStripeErrors<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw translateStripeError(err);
    }
  };
}
