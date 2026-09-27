// ── Stripe webhook events ──
// Two destinations feed one route:
//  • snapshot events from connected accounts (`@accounts`): checkout, refunds, disputes
//  • thin v2 events about the sellers' v2 Accounts (`@self`): onboarding progress
// Both use the same `Stripe-Signature` scheme, so the route verifies first and
// only then looks at the body to tell the formats apart.

import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { VerifiedProviderEvent } from '@plumbus/payments';
import Stripe from 'stripe';

/** Snapshot (v1) event types the adapter acts on, delivered from sellers' accounts. */
export const STRIPE_SNAPSHOT_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
] as const;

/** Thin (v2) event types about sellers' v2 Accounts. */
export const STRIPE_THIN_EVENTS = [
  'v2.core.account.created',
  'v2.core.account.updated',
  'v2.core.account.closed',
  'v2.core.account[requirements].updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[configuration.merchant].capability_status_updated',
  'v2.core.account[defaults].updated',
  'v2.core.account[identity].updated',
] as const;

const RELEVANT: ReadonlySet<string> = new Set([...STRIPE_SNAPSHOT_EVENTS, ...STRIPE_THIN_EVENTS]);

export function isRelevantStripeEvent(type: string): boolean {
  return RELEVANT.has(type);
}

interface SnapshotBody {
  object: 'event';
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  account?: string | null;
  data?: { object?: { id?: string; object?: string } };
}

interface ThinBody {
  object: 'v2.core.event';
  id: string;
  type: string;
  created: string;
  livemode: boolean;
  context?: string | null;
  related_object?: { id?: string; type?: string } | null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verify `Stripe-Signature` against any of the configured secrets (one per
 * destination, plus old secrets during a rotation), then normalize the body.
 */
export function verifyStripeWebhook(input: {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secrets: readonly string[];
  toleranceSeconds: number;
}): VerifiedProviderEvent {
  const header = headerValue(input.headers['stripe-signature']);
  if (!header) {
    throw new PlumbusError(ErrorCode.Unauthorized, 'Missing Stripe-Signature header', {
      reason: 'stripe_signature_missing',
    });
  }
  const signature = Stripe.webhooks.signature;
  const verified = input.secrets.some((secret) => {
    try {
      return (
        signature?.verifyHeader(input.rawBody, header, secret, input.toleranceSeconds) === true
      );
    } catch {
      return false;
    }
  });
  if (!verified) {
    throw new PlumbusError(ErrorCode.Unauthorized, 'Stripe signature did not verify', {
      reason: 'stripe_signature_invalid',
    });
  }

  const body = JSON.parse(input.rawBody.toString('utf8')) as SnapshotBody | ThinBody;
  if (body.object === 'event') {
    return {
      eventId: body.id,
      type: body.type,
      format: 'snapshot',
      livemode: body.livemode,
      occurredAt: new Date(body.created * 1000),
      accountId: body.account ?? null,
      objectId: body.data?.object?.id ?? null,
      objectType: body.data?.object?.object ?? null,
      payload: body,
    };
  }
  if (body.object === 'v2.core.event') {
    const related = body.related_object ?? null;
    const isAccount = related?.type === 'v2.core.account';
    return {
      eventId: body.id,
      type: body.type,
      format: 'thin',
      livemode: body.livemode,
      occurredAt: new Date(body.created),
      accountId: isAccount ? (related?.id ?? null) : (body.context ?? null),
      objectId: related?.id ?? null,
      objectType: related?.type ?? null,
      payload: body,
    };
  }
  throw new PlumbusError(ErrorCode.Validation, 'Unrecognized Stripe webhook body', {
    reason: 'stripe_webhook_unrecognized',
  });
}
