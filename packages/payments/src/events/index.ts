// ── Payments events ──
// Provider-neutral domain events. App code reacts to these with its own
// eventHandler capabilities (grant access on payments.charge.paid, notify on
// payments.dispute.opened, …). Register every event in app/events
// (`export const paymentEvents = payments.events`).
// Timestamps are ISO-8601 strings; amounts are integers in minor units.
// Seller fields are null for the platform's own charges and plans.

import { defineEvent } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const PaymentEventName = {
  MerchantUpdated: 'payments.merchant.updated',
  ChargeCreated: 'payments.charge.created',
  ChargeAuthorized: 'payments.charge.authorized',
  ChargeActionRequired: 'payments.charge.actionRequired',
  ChargePaid: 'payments.charge.paid',
  ChargeFailed: 'payments.charge.failed',
  ChargeExpired: 'payments.charge.expired',
  ChargeCanceled: 'payments.charge.canceled',
  ChargeRefunded: 'payments.charge.refunded',
  RefundFailed: 'payments.refund.failed',
  DisputeOpened: 'payments.dispute.opened',
  DisputeUpdated: 'payments.dispute.updated',
  DisputeClosed: 'payments.dispute.closed',
  PaymentMethodSaved: 'payments.paymentMethod.saved',
  SubscriptionStarted: 'payments.subscription.started',
  SubscriptionUpdated: 'payments.subscription.updated',
  SubscriptionEnded: 'payments.subscription.ended',
  InvoicePaid: 'payments.invoice.paid',
  InvoicePaymentFailed: 'payments.invoice.paymentFailed',
  TransferCreated: 'payments.transfer.created',
  TransferReversed: 'payments.transfer.reversed',
  PayoutPaid: 'payments.payout.paid',
  PayoutFailed: 'payments.payout.failed',
  EntitlementsUpdated: 'payments.entitlements.updated',
  ProviderEventReceived: 'payments.provider.eventReceived',
} as const;

const flow = z.enum(['direct', 'destination', 'platform']);

const seller = {
  merchantAccountId: z.string().nullable(),
  ownerType: z.enum(['user', 'tenant']).nullable(),
  ownerId: z.string().nullable(),
};

const requiredSeller = {
  merchantAccountId: z.string(),
  ownerType: z.enum(['user', 'tenant']),
  ownerId: z.string(),
};

export const merchantUpdatedEvent = defineEvent({
  name: PaymentEventName.MerchantUpdated,
  domain: 'payments',
  description: 'A seller account changed status, abilities, or outstanding requirements',
  payload: z.object({
    ...requiredSeller,
    status: z.enum(['onboarding', 'active', 'restricted', 'closed']),
    previousStatus: z.enum(['onboarding', 'active', 'restricted', 'closed']).nullable(),
    chargesEnabled: z.boolean(),
    transfersEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    requirementsDue: z.array(z.string()),
  }),
});

const chargeBase = {
  ...seller,
  chargeId: z.string(),
  flow,
  amount: z.number().int(),
  currency: z.string(),
  clientId: z.string().nullable(),
  billingCustomerId: z.string().nullable(),
};

export const chargeCreatedEvent = defineEvent({
  name: PaymentEventName.ChargeCreated,
  domain: 'payments',
  description: 'A payment request was created (payment page, invoice, or saved-method charge)',
  payload: z.object({
    ...chargeBase,
    collection: z.enum(['checkout', 'invoice', 'saved_method', 'link']),
    platformFeeAmount: z.number().int(),
    createdBy: z.string().nullable(),
  }),
});

export const chargeAuthorizedEvent = defineEvent({
  name: PaymentEventName.ChargeAuthorized,
  domain: 'payments',
  description: "The amount is held on the client's payment method; capture or cancel it",
  payload: z.object({
    ...chargeBase,
    amountCapturable: z.number().int(),
    captureBefore: z.string().nullable(),
  }),
});

export const chargeActionRequiredEvent = defineEvent({
  name: PaymentEventName.ChargeActionRequired,
  domain: 'payments',
  description: 'Charging a saved payment method needs the client; send them the payment link',
  payload: z.object({
    ...chargeBase,
    url: z.string().nullable(),
    failureCode: z.string().nullable(),
  }),
});

export const chargePaidEvent = defineEvent({
  name: PaymentEventName.ChargePaid,
  domain: 'payments',
  description: 'A client paid a charge; the money is on its way to the seller or the platform',
  payload: z.object({
    ...chargeBase,
    amountTotal: z.number().int(),
    platformFeeAmount: z.number().int(),
    linkId: z.string().nullable(),
    paidAt: z.string(),
  }),
});

export const chargeFailedEvent = defineEvent({
  name: PaymentEventName.ChargeFailed,
  domain: 'payments',
  description: 'A payment failed (a delayed method bounced, or an invoice became uncollectible)',
  payload: z.object({ ...chargeBase, failureCode: z.string().nullable() }),
});

export const chargeExpiredEvent = defineEvent({
  name: PaymentEventName.ChargeExpired,
  domain: 'payments',
  description: 'A payment link expired unpaid',
  payload: z.object(chargeBase),
});

export const chargeCanceledEvent = defineEvent({
  name: PaymentEventName.ChargeCanceled,
  domain: 'payments',
  description: 'A charge was canceled: a hold released or an invoice voided',
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
  description: 'A client disputed a charge with their bank; the disputed amount is withdrawn',
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

export const paymentMethodSavedEvent = defineEvent({
  name: PaymentEventName.PaymentMethodSaved,
  domain: 'payments',
  description: 'A client saved a payment method for later charges',
  payload: z.object({
    ...seller,
    clientId: z.string(),
    paymentMethodId: z.string(),
    type: z.string(),
    brand: z.string().nullable(),
    last4: z.string().nullable(),
  }),
});

const subscriptionPayload = z.object({
  ...seller,
  subscriptionId: z.string(),
  payee: z.enum(['seller', 'platform']),
  clientId: z.string().nullable(),
  billingCustomerId: z.string().nullable(),
  billingOwnerType: z.enum(['tenant', 'user', 'seller']).nullable(),
  billingOwnerId: z.string().nullable(),
  plan: z.string().nullable(),
  planPrice: z.string().nullable(),
  status: z.enum([
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'paused',
    'canceled',
  ]),
  previousStatus: z.string().nullable(),
  quantity: z.number().int(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export const subscriptionStartedEvent = defineEvent({
  name: PaymentEventName.SubscriptionStarted,
  domain: 'payments',
  description: 'A subscription became active or started its trial',
  payload: subscriptionPayload,
});

export const subscriptionUpdatedEvent = defineEvent({
  name: PaymentEventName.SubscriptionUpdated,
  domain: 'payments',
  description: 'A subscription changed status, plan, quantity, or its cancel-at-period-end setting',
  payload: subscriptionPayload,
});

export const subscriptionEndedEvent = defineEvent({
  name: PaymentEventName.SubscriptionEnded,
  domain: 'payments',
  description: 'A subscription ended (canceled, or its first payment never completed)',
  payload: subscriptionPayload,
});

const invoicePayload = z.object({
  ...seller,
  invoiceId: z.string(),
  subscriptionId: z.string().nullable(),
  billingCustomerId: z.string().nullable(),
  amountDue: z.number().int(),
  amountPaid: z.number().int(),
  currency: z.string(),
  hostedUrl: z.string().nullable(),
  billingReason: z.string().nullable(),
});

export const invoicePaidEvent = defineEvent({
  name: PaymentEventName.InvoicePaid,
  domain: 'payments',
  description: 'A subscription invoice was paid',
  payload: invoicePayload,
});

export const invoicePaymentFailedEvent = defineEvent({
  name: PaymentEventName.InvoicePaymentFailed,
  domain: 'payments',
  description: 'Collecting a subscription invoice failed; the provider retries on its schedule',
  payload: invoicePayload,
});

const transferPayload = z.object({
  ...requiredSeller,
  transferId: z.string(),
  chargeId: z.string().nullable(),
  amount: z.number().int(),
  amountReversed: z.number().int(),
  currency: z.string(),
  transferGroup: z.string().nullable(),
});

export const transferCreatedEvent = defineEvent({
  name: PaymentEventName.TransferCreated,
  domain: 'payments',
  description: 'The platform sent money to a seller',
  payload: transferPayload,
});

export const transferReversedEvent = defineEvent({
  name: PaymentEventName.TransferReversed,
  domain: 'payments',
  description: 'Money sent to a seller was (partly) taken back',
  payload: transferPayload,
});

const payoutPayload = z.object({
  ...requiredSeller,
  payoutId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  method: z.enum(['standard', 'instant']),
  arrivalDate: z.string().nullable(),
  failureCode: z.string().nullable(),
});

export const payoutPaidEvent = defineEvent({
  name: PaymentEventName.PayoutPaid,
  domain: 'payments',
  description: "A payout reached the seller's bank account or card",
  payload: payoutPayload,
});

export const payoutFailedEvent = defineEvent({
  name: PaymentEventName.PayoutFailed,
  domain: 'payments',
  description: 'A payout failed; the seller must update their bank details',
  payload: payoutPayload,
});

export const entitlementsUpdatedEvent = defineEvent({
  name: PaymentEventName.EntitlementsUpdated,
  domain: 'payments',
  description: "A billing customer's plan features changed",
  payload: z.object({
    billingCustomerId: z.string(),
    ownerType: z.enum(['tenant', 'user', 'seller']),
    ownerId: z.string(),
    features: z.array(z.string()),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
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

/** All payments events, in registration order. Register every one. */
export const paymentEvents = [
  merchantUpdatedEvent,
  chargeCreatedEvent,
  chargeAuthorizedEvent,
  chargeActionRequiredEvent,
  chargePaidEvent,
  chargeFailedEvent,
  chargeExpiredEvent,
  chargeCanceledEvent,
  chargeRefundedEvent,
  refundFailedEvent,
  disputeOpenedEvent,
  disputeUpdatedEvent,
  disputeClosedEvent,
  paymentMethodSavedEvent,
  subscriptionStartedEvent,
  subscriptionUpdatedEvent,
  subscriptionEndedEvent,
  invoicePaidEvent,
  invoicePaymentFailedEvent,
  transferCreatedEvent,
  transferReversedEvent,
  payoutPaidEvent,
  payoutFailedEvent,
  entitlementsUpdatedEvent,
  providerEventReceivedEvent,
] as const;
