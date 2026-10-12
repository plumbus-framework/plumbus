// ── Zod shapes shared by the payments capabilities ──

import { z } from '@plumbus/core/zod';
import type { ProviderStateChange, ProviderSubscription } from '../types/provider.js';

export const dashboardSchema = z.enum(['full', 'express', 'none']);
export const merchantStatusSchema = z.enum(['onboarding', 'active', 'restricted', 'closed']);
export const chargeStatusSchema = z.enum([
  'open',
  'requires_action',
  'processing',
  'authorized',
  'paid',
  'failed',
  'expired',
  'canceled',
]);
export const refundStatusSchema = z.enum([
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'canceled',
]);
export const disputeStatusSchema = z.enum([
  'needs_response',
  'under_review',
  'won',
  'lost',
  'closed',
]);
export const subscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
]);
export const invoiceStatusSchema = z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']);
export const payoutStatusSchema = z.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled']);
export const responsibilitySchema = z.enum(['provider', 'platform']);
export const flowSchema = z.enum(['direct', 'destination', 'platform']);
export const collectionSchema = z.enum(['checkout', 'invoice', 'saved_method', 'link']);
export const intervalSchema = z.enum(['day', 'week', 'month', 'year']);
export const componentSchema = z.enum([
  'onboarding',
  'account',
  'notifications',
  'payments',
  'payouts',
  'balances',
  'disputes',
  'documents',
]);

export const amountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Amount in minor units (cents)');
export const currencySchema = z
  .string()
  .regex(/^[a-z]{3}$/, 'Use a lowercase ISO 4217 code, e.g. "usd"');
export const metadataSchema = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((value) => Object.keys(value).length <= 20, 'At most 20 metadata keys')
  .refine(
    (value) => Object.keys(value).every((name) => !name.startsWith('plumbus_')),
    'Metadata keys starting with "plumbus_" are reserved',
  );

export const itemInputSchema = z.object({
  name: z.string().min(1).max(250),
  description: z.string().min(1).max(500).optional(),
  unitAmount: amountSchema.describe('Minor units per unit'),
  quantity: z.number().int().min(1).max(10_000).default(1),
});

export const customAmountSchema = z
  .object({
    minimum: amountSchema.optional(),
    maximum: amountSchema.optional(),
    preset: amountSchema.optional(),
  })
  .refine((v) => !v.minimum || !v.maximum || v.minimum <= v.maximum, 'minimum above maximum')
  .describe('Let the client choose the amount (one item only)');

export const checkoutOptionsSchema = z
  .object({
    allowPromotionCodes: z.boolean().optional(),
    automaticTax: z.boolean().optional(),
    billingAddress: z.enum(['auto', 'required']).optional(),
    phone: z.boolean().optional(),
    shippingCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .optional(),
    locale: z.string().min(2).max(10).optional(),
    submitType: z.enum(['auto', 'pay', 'book', 'donate']).optional(),
    statementDescriptorSuffix: z
      .string()
      .min(1)
      .max(22)
      .regex(/^[^<>\\'"*]+$/, 'No < > \\ \' " or *')
      .optional(),
  })
  .describe('Payment page options; unset options use the config');

export const merchantViewSchema = z.object({
  id: z.string(),
  ownerType: z.enum(['user', 'tenant']),
  ownerId: z.string(),
  provider: z.string(),
  dashboard: dashboardSchema,
  chargeType: z.enum(['direct', 'destination']),
  feesCollector: responsibilitySchema,
  lossesCollector: responsibilitySchema,
  country: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
  status: merchantStatusSchema,
  chargesEnabled: z.boolean(),
  transfersEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  requirementsDue: z.array(z.string()),
  requirementsPastDue: z.array(z.string()),
  disabledReason: z.string().nullable(),
  livemode: z.boolean(),
});

export const itemViewSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  unitAmount: z.number().int(),
  quantity: z.number().int(),
});

export const chargeViewSchema = z.object({
  id: z.string(),
  merchantAccountId: z.string().nullable(),
  clientId: z.string().nullable(),
  flow: flowSchema,
  collection: collectionSchema,
  capture: z.enum(['automatic', 'manual']),
  status: chargeStatusSchema,
  amount: z.number().int(),
  customAmount: z.boolean(),
  amountTotal: z.number().int().nullable(),
  amountDiscount: z.number().int(),
  amountTax: z.number().int(),
  currency: z.string(),
  platformFeeAmount: z.number().int(),
  amountRefunded: z.number().int(),
  amountCapturable: z.number().int(),
  captureBefore: z.string().nullable(),
  description: z.string(),
  items: z.array(itemViewSchema),
  /** Hosted payment page, invoice page, or the page a client with a failed saved method pays on. */
  url: z.string().nullable(),
  /** Embedded payment pages: what your front end mounts. */
  checkout: z
    .object({
      clientSecret: z.string(),
      publishableKey: z.string().nullable(),
      accountId: z.string().nullable(),
    })
    .nullable(),
  expiresAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  clientEmail: z.string().nullable(),
  paymentMethodId: z.string().nullable(),
  failureCode: z.string().nullable(),
  linkId: z.string().nullable(),
  transferGroup: z.string().nullable(),
  billingCustomerId: z.string().nullable(),
  metadata: z.record(z.string()),
  createdAt: z.string().nullable(),
  livemode: z.boolean(),
});

export const refundViewSchema = z.object({
  id: z.string(),
  chargeId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: refundStatusSchema,
  reason: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const disputeViewSchema = z.object({
  id: z.string(),
  chargeId: z.string().nullable(),
  amount: z.number().int(),
  currency: z.string(),
  status: disputeStatusSchema,
  reason: z.string().nullable(),
  evidenceDueBy: z.string().nullable(),
  evidenceSubmitted: z.boolean(),
  createdAt: z.string().nullable(),
});

export const clientViewSchema = z.object({
  id: z.string(),
  reference: z.string().nullable(),
  userId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const paymentMethodViewSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  type: z.string(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  status: z.enum(['active', 'removed']),
});

export const subscriptionItemViewSchema = z.object({
  priceId: z.string(),
  lookupKey: z.string().nullable(),
  name: z.string(),
  unitAmount: z.number().int().nullable(),
  interval: intervalSchema,
  intervalCount: z.number().int(),
  quantity: z.number().int(),
  metered: z.boolean(),
});

export const subscriptionViewSchema = z.object({
  id: z.string(),
  payee: z.enum(['seller', 'platform']),
  merchantAccountId: z.string().nullable(),
  clientId: z.string().nullable(),
  billingCustomerId: z.string().nullable(),
  plan: z.string().nullable(),
  planPrice: z.string().nullable(),
  status: subscriptionStatusSchema,
  currency: z.string(),
  items: z.array(subscriptionItemViewSchema),
  quantity: z.number().int(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: z.string().nullable(),
  trialEnd: z.string().nullable(),
  /** Checkout page while the subscription waits for its first payment. */
  checkoutUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  livemode: z.boolean(),
});

export const invoiceViewSchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(),
  status: invoiceStatusSchema,
  currency: z.string(),
  amountDue: z.number().int(),
  amountPaid: z.number().int(),
  amountRemaining: z.number().int(),
  hostedUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  number: z.string().nullable(),
  dueDate: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
});

export const linkViewSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  active: z.boolean(),
  currency: z.string(),
  description: z.string(),
  items: z.array(
    itemViewSchema.extend({
      adjustableQuantity: z.object({ minimum: z.number(), maximum: z.number() }).nullable(),
    }),
  ),
  customAmount: z.boolean(),
  platformFeeAmount: z.number().int(),
  createdAt: z.string().nullable(),
});

export const transferViewSchema = z.object({
  id: z.string(),
  merchantAccountId: z.string(),
  chargeId: z.string().nullable(),
  amount: z.number().int(),
  amountReversed: z.number().int(),
  currency: z.string(),
  transferGroup: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const payoutViewSchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: payoutStatusSchema,
  method: z.enum(['standard', 'instant']),
  arrivalDate: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const payoutScheduleSchema = z.object({
  interval: z.enum(['manual', 'daily', 'weekly', 'monthly']),
  delayDays: z.union([z.number().int().min(0).max(31), z.literal('minimum')]).optional(),
  weeklyAnchor: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']).optional(),
  monthlyAnchor: z.number().int().min(1).max(31).optional(),
});

// ── Provider state changes, serialized for applyProviderState (dates as ISO) ──

const isoOrNull = z.string().nullable();
const intOrNull = z.number().int().nullable();

const paymentMethodShape = z.object({
  id: z.string(),
  customerId: z.string().nullable(),
  type: z.string(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: intOrNull,
  expYear: intOrNull,
});

const merchantChange = z.object({
  kind: z.literal('merchant'),
  account: z.object({
    id: z.string(),
    dashboard: dashboardSchema,
    feesCollector: responsibilitySchema,
    lossesCollector: responsibilitySchema,
    country: z.string().nullable(),
    defaultCurrency: z.string().nullable(),
    chargesEnabled: z.boolean(),
    transfersEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    requirementsDue: z.array(z.string()),
    requirementsPastDue: z.array(z.string()),
    disabledReason: z.string().nullable(),
    closed: z.boolean(),
    livemode: z.boolean(),
  }),
});

const chargeChange = z.object({
  kind: z.literal('charge'),
  accountId: z.string().nullable(),
  charge: z.object({
    id: z.string(),
    reference: z.string().nullable(),
    paymentId: z.string().nullable(),
    linkId: z.string().nullable(),
    status: chargeStatusSchema,
    currency: z.string(),
    amountSubtotal: intOrNull,
    amountTotal: intOrNull,
    amountDiscount: intOrNull,
    amountTax: intOrNull,
    platformFeeAmount: intOrNull,
    amountRefunded: intOrNull,
    amountCapturable: intOrNull,
    captureBefore: isoOrNull,
    url: z.string().nullable(),
    clientSecret: z.string().nullable(),
    expiresAt: isoOrNull,
    paidAt: isoOrNull,
    clientEmail: z.string().nullable(),
    customerId: z.string().nullable(),
    savedMethod: paymentMethodShape.nullable(),
    failureCode: z.string().nullable(),
    livemode: z.boolean(),
  }),
});

const refundChange = z.object({
  kind: z.literal('refund'),
  accountId: z.string().nullable(),
  chargeReference: z.string().nullable(),
  refund: z.object({
    id: z.string(),
    reference: z.string().nullable(),
    paymentId: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    status: refundStatusSchema,
    reason: z.string().nullable(),
    failureReason: z.string().nullable(),
  }),
});

const disputeChange = z.object({
  kind: z.literal('dispute'),
  accountId: z.string().nullable(),
  chargeReference: z.string().nullable(),
  dispute: z.object({
    id: z.string(),
    paymentId: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    status: disputeStatusSchema,
    providerStatus: z.string(),
    reason: z.string().nullable(),
    evidenceDueBy: isoOrNull,
    evidenceSubmitted: z.boolean(),
  }),
});

const paymentMethodChange = z.object({
  kind: z.literal('payment_method'),
  accountId: z.string().nullable(),
  method: paymentMethodShape,
  detached: z.boolean(),
});

const subscriptionChange = z.object({
  kind: z.literal('subscription'),
  accountId: z.string().nullable(),
  subscription: z.object({
    id: z.string(),
    reference: z.string().nullable(),
    customerId: z.string(),
    status: subscriptionStatusSchema,
    currency: z.string(),
    items: z.array(
      z.object({
        id: z.string(),
        priceId: z.string(),
        lookupKey: z.string().nullable(),
        name: z.string(),
        unitAmount: intOrNull,
        currency: z.string(),
        interval: intervalSchema,
        intervalCount: z.number().int(),
        quantity: z.number().int(),
        metered: z.boolean(),
      }),
    ),
    currentPeriodEnd: isoOrNull,
    cancelAtPeriodEnd: z.boolean(),
    canceledAt: isoOrNull,
    endedAt: isoOrNull,
    trialEnd: isoOrNull,
    latestInvoiceId: z.string().nullable(),
    applicationFeePercent: z.number().nullable(),
    livemode: z.boolean(),
  }),
});

const invoiceChange = z.object({
  kind: z.literal('invoice'),
  accountId: z.string().nullable(),
  invoice: z.object({
    id: z.string(),
    reference: z.string().nullable(),
    subscriptionId: z.string().nullable(),
    customerId: z.string().nullable(),
    status: invoiceStatusSchema,
    currency: z.string(),
    amountDue: z.number().int(),
    amountPaid: z.number().int(),
    amountRemaining: z.number().int(),
    hostedUrl: z.string().nullable(),
    pdfUrl: z.string().nullable(),
    number: z.string().nullable(),
    dueDate: isoOrNull,
    paymentId: z.string().nullable(),
    periodStart: isoOrNull,
    periodEnd: isoOrNull,
    billingReason: z.string().nullable(),
    attemptCount: z.number().int(),
    livemode: z.boolean(),
  }),
});

const subscriptionCheckoutExpiredChange = z.object({
  kind: z.literal('subscription_checkout_expired'),
  accountId: z.string().nullable(),
  checkoutId: z.string(),
  reference: z.string().nullable(),
});

const transferChange = z.object({
  kind: z.literal('transfer'),
  transfer: z.object({
    id: z.string(),
    reference: z.string().nullable(),
    destinationAccountId: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    amountReversed: z.number().int(),
    transferGroup: z.string().nullable(),
    sourcePaymentId: z.string().nullable(),
    livemode: z.boolean(),
  }),
});

const payoutChange = z.object({
  kind: z.literal('payout'),
  accountId: z.string(),
  payout: z.object({
    id: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    status: payoutStatusSchema,
    method: z.enum(['standard', 'instant']),
    arrivalDate: isoOrNull,
    failureCode: z.string().nullable(),
    livemode: z.boolean(),
  }),
});

const entitlementsChange = z.object({
  kind: z.literal('entitlements'),
  customerId: z.string(),
  features: z.array(z.string()),
});

export const stateChangeSchema = z.discriminatedUnion('kind', [
  merchantChange,
  chargeChange,
  refundChange,
  disputeChange,
  paymentMethodChange,
  subscriptionChange,
  subscriptionCheckoutExpiredChange,
  invoiceChange,
  transferChange,
  payoutChange,
  entitlementsChange,
]);
export type SerializedStateChange = z.infer<typeof stateChangeSchema>;

const toIso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** Dates → ISO strings so changes survive capability input validation. */
export function serializeChange(change: ProviderStateChange): SerializedStateChange {
  switch (change.kind) {
    case 'merchant':
      return { kind: 'merchant', account: { ...change.account } };
    case 'charge':
      return {
        kind: 'charge',
        accountId: change.accountId,
        charge: {
          ...change.charge,
          captureBefore: toIso(change.charge.captureBefore),
          expiresAt: toIso(change.charge.expiresAt),
          paidAt: toIso(change.charge.paidAt),
        },
      };
    case 'refund':
      return {
        kind: 'refund',
        accountId: change.accountId,
        chargeReference: change.chargeReference,
        refund: { ...change.refund },
      };
    case 'dispute':
      return {
        kind: 'dispute',
        accountId: change.accountId,
        chargeReference: change.chargeReference,
        dispute: { ...change.dispute, evidenceDueBy: toIso(change.dispute.evidenceDueBy) },
      };
    case 'payment_method':
      return { ...change, method: { ...change.method } };
    case 'subscription':
      return {
        kind: 'subscription',
        accountId: change.accountId,
        subscription: serializeSubscription(change.subscription),
      };
    case 'invoice':
      return {
        kind: 'invoice',
        accountId: change.accountId,
        invoice: {
          ...change.invoice,
          dueDate: toIso(change.invoice.dueDate),
          periodStart: toIso(change.invoice.periodStart),
          periodEnd: toIso(change.invoice.periodEnd),
        },
      };
    case 'subscription_checkout_expired':
      return { ...change };
    case 'transfer':
      return { kind: 'transfer', transfer: { ...change.transfer } };
    case 'payout':
      return {
        kind: 'payout',
        accountId: change.accountId,
        payout: { ...change.payout, arrivalDate: toIso(change.payout.arrivalDate) },
      };
    case 'entitlements':
      return {
        kind: 'entitlements',
        customerId: change.customerId,
        features: [...change.features],
      };
  }
}

export type SerializedSubscription = Extract<
  SerializedStateChange,
  { kind: 'subscription' }
>['subscription'];

export function serializeSubscription(subscription: ProviderSubscription): SerializedSubscription {
  return {
    ...subscription,
    items: subscription.items.map((item) => ({ ...item })),
    currentPeriodEnd: toIso(subscription.currentPeriodEnd),
    canceledAt: toIso(subscription.canceledAt),
    endedAt: toIso(subscription.endedAt),
    trialEnd: toIso(subscription.trialEnd),
  };
}
