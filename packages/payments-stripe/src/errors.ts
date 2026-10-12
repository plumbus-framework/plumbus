// ── Stripe errors → Plumbus errors ──
// Capabilities surface provider failures to sellers, so Stripe's message and
// codes are kept (e.g. "Amount must be at least $0.50 usd") while the error
// becomes a structured PlumbusError the HTTP layer maps to a status.

import { ErrorCode, PlumbusError } from '@plumbus/core';
import Stripe from 'stripe';

/**
 * Stripe no longer has a customer this app saved (another Stripe account in the
 * same mode, or a reset test account). Stripe names the `customer` parameter;
 * the message is the fallback for responses that do not.
 */
function isMissingCustomer(err: InstanceType<typeof Stripe.errors.StripeError>): boolean {
  return (
    err.code === 'resource_missing' &&
    (err.param === 'customer' || /^No such customer\b/.test(err.message))
  );
}

export function translateStripeError(err: unknown): unknown {
  if (!(err instanceof Stripe.errors.StripeError)) return err;
  const metadata = {
    // The provider contract's reason, so @plumbus/payments can replace the customer and retry.
    reason: isMissingCustomer(err) ? 'payments_provider_customer_missing' : 'stripe_error',
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
