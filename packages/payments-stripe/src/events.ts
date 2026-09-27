// ── Stripe webhook events ──
// Two destinations feed one route:
//  • snapshot events from the platform account (`@self`) and from sellers'
//    accounts (`@accounts`): checkout, payments, refunds, disputes, saved
//    methods, subscriptions, invoices, transfers, payouts, entitlements
//  • thin v2 events about the sellers' v2 Accounts (`@self`): onboarding progress
// Both use the same `Stripe-Signature` scheme, so the route verifies first and
// only then looks at the body to tell the formats apart.

import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { ProviderEventRouting, VerifiedProviderEvent } from '@plumbus/payments';
import Stripe from 'stripe';

/** Snapshot (v1) event types the adapter acts on, from the platform and from sellers' accounts. */
export const STRIPE_SNAPSHOT_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.canceled',
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
  'payment_method.attached',
  'payment_method.updated',
  'payment_method.detached',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
  'payout.created',
  'payout.updated',
  'payout.paid',
  'payout.failed',
  'payout.canceled',
  'entitlements.active_entitlement_summary.updated',
] as const;

/** Thin (v2) event types about sellers' v2 Accounts. */
export const STRIPE_THIN_EVENTS = [
  'v2.core.account.created',
  'v2.core.account.updated',
  'v2.core.account.closed',
  'v2.core.account[requirements].updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[configuration.merchant].capability_status_updated',
  'v2.core.account[configuration.recipient].updated',
  'v2.core.account[configuration.recipient].capability_status_updated',
  'v2.core.account[defaults].updated',
  'v2.core.account[identity].updated',
] as const;

/** Where the snapshot destination takes events from: the platform itself and every seller. */
export const STRIPE_SNAPSHOT_SOURCES = ['@self', '@accounts'] as const;

const RELEVANT: ReadonlySet<string> = new Set([...STRIPE_SNAPSHOT_EVENTS, ...STRIPE_THIN_EVENTS]);

export function isRelevantStripeEvent(type: string): boolean {
  return RELEVANT.has(type);
}

type Ref = string | { id?: string } | null | undefined;

interface SnapshotObject {
  id?: string;
  object?: string;
  metadata?: Record<string, string> | null;
  customer?: Ref;
  payment_intent?: Ref;
  subscription?: Ref;
  parent?: { subscription_details?: { subscription?: Ref } | null } | null;
}

interface SnapshotBody {
  object: 'event';
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  account?: string | null;
  data?: { object?: SnapshotObject };
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

const refId = (value: Ref): string | null =>
  value == null ? null : typeof value === 'string' ? value : (value.id ?? null);

const NO_ROUTING: ProviderEventRouting = {
  tenantId: null,
  customerId: null,
  paymentId: null,
  subscriptionId: null,
};

/** Hints for finding the tenant of a platform-account event, read from the object itself. */
export function routingOf(object: SnapshotObject | undefined): ProviderEventRouting {
  if (!object) return NO_ROUTING;
  const kind = object.object;
  return {
    tenantId: object.metadata?.plumbus_tenant_id ?? null,
    customerId: kind === 'customer' ? (object.id ?? null) : refId(object.customer),
    paymentId: kind === 'payment_intent' ? (object.id ?? null) : refId(object.payment_intent),
    subscriptionId:
      kind === 'subscription'
        ? (object.id ?? null)
        : (refId(object.subscription) ?? refId(object.parent?.subscription_details?.subscription)),
  };
}

/** The object an event is about; entitlement summaries have no id of their own, only a customer. */
function objectIdOf(object: SnapshotObject | undefined): string | null {
  if (!object) return null;
  if (object.object === 'entitlements.active_entitlement_summary') return refId(object.customer);
  return object.id ?? null;
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
      objectId: objectIdOf(body.data?.object),
      objectType: body.data?.object?.object ?? null,
      routing: routingOf(body.data?.object),
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
      routing: NO_ROUTING,
      payload: body,
    };
  }
  throw new PlumbusError(ErrorCode.Validation, 'Unrecognized Stripe webhook body', {
    reason: 'stripe_webhook_unrecognized',
  });
}
