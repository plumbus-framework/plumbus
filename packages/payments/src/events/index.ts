// ── Payments events ──
// Provider-neutral domain events. App code reacts to these with its own
// eventHandler capabilities (grant access on payments.charge.paid, notify on
// payments.dispute.opened, …). Register every event in app/events.
// Timestamps are ISO-8601 strings; amounts are integers in minor units.

import { defineEvent } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const PaymentEventName = {
  MerchantUpdated: 'payments.merchant.updated',
  ChargeCreated: 'payments.charge.created',
  ChargePaid: 'payments.charge.paid',
  ChargeFailed: 'payments.charge.failed',
  ChargeExpired: 'payments.charge.expired',
  ChargeRefunded: 'payments.charge.refunded',
  RefundFailed: 'payments.refund.failed',
  DisputeOpened: 'payments.dispute.opened',
  DisputeUpdated: 'payments.dispute.updated',
  DisputeClosed: 'payments.dispute.closed',
  ProviderEventReceived: 'payments.provider.eventReceived',
} as const;

const seller = {
  merchantAccountId: z.string(),
  ownerType: z.enum(['user', 'tenant']),
  ownerId: z.string(),
};

export const merchantUpdatedEvent = defineEvent({
  name: PaymentEventName.MerchantUpdated,
  domain: 'payments',
  description: 'A seller account changed status, abilities, or outstanding requirements',
  payload: z.object({
    ...seller,
    status: z.enum(['onboarding', 'active', 'restricted', 'closed']),
    previousStatus: z.enum(['onboarding', 'active', 'restricted', 'closed']).nullable(),
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    requirementsDue: z.array(z.string()),
  }),
});

const chargeBase = {
  ...seller,
  chargeId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
};

export const chargeCreatedEvent = defineEvent({
  name: PaymentEventName.ChargeCreated,
  domain: 'payments',
  description: 'A seller created a payment link for a client',
  payload: z.object({
    ...chargeBase,
    platformFeeAmount: z.number().int(),
    clientId: z.string().nullable(),
    createdBy: z.string().nullable(),
  }),
});

export const chargePaidEvent = defineEvent({
  name: PaymentEventName.ChargePaid,
  domain: 'payments',
  description: 'A client paid a charge; the money is on its way to the seller',
  payload: z.object({
    ...chargeBase,
    platformFeeAmount: z.number().int(),
    clientId: z.string().nullable(),
    paidAt: z.string(),
  }),
});

export const chargeFailedEvent = defineEvent({
  name: PaymentEventName.ChargeFailed,
  domain: 'payments',
  description: 'A delayed payment method (for example a bank debit) failed',
  payload: z.object(chargeBase),
});

export const chargeExpiredEvent = defineEvent({
  name: PaymentEventName.ChargeExpired,
  domain: 'payments',
  description: 'A payment link expired unpaid',
  payload: z.object(chargeBase),
});

export const chargeRefundedEvent = defineEvent({
  name: PaymentEventName.ChargeRefunded,
  domain: 'payments',
  description: 'Money was returned to the client (fully or partly)',
  payload: z.object({
    ...chargeBase,
    amountRefunded: z.number().int(),
    fullyRefunded: z.boolean(),
  }),
});

export const refundFailedEvent = defineEvent({
  name: PaymentEventName.RefundFailed,
  domain: 'payments',
  description: 'A refund could not be completed',
  payload: z.object({
    ...seller,
    refundId: z.string(),
    chargeId: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    failureReason: z.string().nullable(),
  }),
});

const disputePayload = z.object({
  ...seller,
  disputeId: z.string(),
  chargeId: z.string().nullable(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(['needs_response', 'under_review', 'won', 'lost', 'closed']),
  reason: z.string().nullable(),
  evidenceDueBy: z.string().nullable(),
});

export const disputeOpenedEvent = defineEvent({
  name: PaymentEventName.DisputeOpened,
  domain: 'payments',
  description: "A client disputed a charge with their bank; the seller's balance is debited",
  payload: disputePayload,
});

export const disputeUpdatedEvent = defineEvent({
  name: PaymentEventName.DisputeUpdated,
  domain: 'payments',
  description: 'A dispute moved to a new status',
  payload: disputePayload,
});

export const disputeClosedEvent = defineEvent({
  name: PaymentEventName.DisputeClosed,
  domain: 'payments',
  description: 'A dispute was won, lost, or closed',
  payload: disputePayload,
});

/** Internal: a verified webhook was recorded and awaits processing by the worker. */
export const providerEventReceivedEvent = defineEvent({
  name: PaymentEventName.ProviderEventReceived,
  domain: 'payments',
  description: 'Internal — a verified provider webhook is queued for processing',
  payload: z.object({
    ledgerId: z.string(),
    provider: z.string(),
    providerEventId: z.string(),
    type: z.string(),
  }),
});

/** All payments events, in registration order. */
export const paymentEvents = [
  merchantUpdatedEvent,
  chargeCreatedEvent,
  chargePaidEvent,
  chargeFailedEvent,
  chargeExpiredEvent,
  chargeRefundedEvent,
  refundFailedEvent,
  disputeOpenedEvent,
  disputeUpdatedEvent,
  disputeClosedEvent,
  providerEventReceivedEvent,
] as const;
