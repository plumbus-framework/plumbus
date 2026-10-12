// ── Payments entities ──
// Local copies of provider state. The provider stays the source of truth;
// these rows make seller screens, access checks, and reports fast and let app
// code read payments through ctx.data. Register every entity in app/entities
// (`export const paymentEntities = payments.entities`).
// Amounts are integers in minor units (cents) stored as 64-bit bigint.

import { defineEntity, ErrorCode, field, PlumbusError } from '@plumbus/core';

/**
 * The peer range admits every core 0.7.x, but money columns need
 * `field.bigint()` (core 0.7.7+). Fail with a clear message instead of
 * "field.bigint is not a function" on older cores.
 */
export function assertCoreSupportsPayments(fields: object = field): void {
  if (typeof (fields as { bigint?: unknown }).bigint !== 'function') {
    throw new PlumbusError(
      ErrorCode.Internal,
      '@plumbus/payments requires @plumbus/core 0.7.7 or newer (field.bigint); upgrade @plumbus/core',
      { reason: 'payments_core_too_old' },
    );
  }
}
assertCoreSupportsPayments();

export const PaymentEntityName = {
  MerchantAccount: 'PaymentMerchantAccount',
  Client: 'PaymentClient',
  Charge: 'PaymentCharge',
  Refund: 'PaymentRefund',
  Dispute: 'PaymentDispute',
  Method: 'PaymentMethod',
  Subscription: 'PaymentSubscription',
  Invoice: 'PaymentInvoice',
  Link: 'PaymentLink',
  Transfer: 'PaymentTransfer',
  Payout: 'PaymentPayout',
  BillingCustomer: 'PaymentBillingCustomer',
  Entitlement: 'PaymentEntitlement',
  ProviderEvent: 'PaymentProviderEvent',
} as const;

const CHARGE_STATUSES = [
  'open',
  'requires_action',
  'processing',
  'authorized',
  'paid',
  'failed',
  'expired',
  'canceled',
] as const;
const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
] as const;
const FLOWS = ['direct', 'destination', 'platform'] as const;

const merchantRelation = (optional = false) =>
  field.relation({
    entity: PaymentEntityName.MerchantAccount,
    type: 'many-to-one',
    ...(optional ? { optional: true } : {}),
  });

export const paymentMerchantAccountEntity = defineEntity({
  name: PaymentEntityName.MerchantAccount,
  domain: 'payments',
  description: 'A seller account at the payment provider, owned by a user or a tenant',
  tenantScoped: true,
  fields: {
    id: field.id(),
    // Declared so the one-account-per-owner index can include it; the repository
    // still fills it from auth.tenantId on every write.
    tenantId: field.string({ required: true }),
    ownerType: field.enum(['user', 'tenant'], { required: true }),
    ownerId: field.string({ required: true }),
    provider: field.string({ required: true }),
    providerAccountId: field.string({ required: true }),
    dashboard: field.enum(['full', 'express', 'none'], { required: true }),
    chargeType: field.enum(['direct', 'destination'], { required: true, default: 'direct' }),
    feesCollector: field.enum(['provider', 'platform'], { required: true }),
    lossesCollector: field.enum(['provider', 'platform'], { required: true }),
    country: field.string({ optional: true }),
    defaultCurrency: field.string({ optional: true }),
    status: field.enum(['onboarding', 'active', 'restricted', 'closed'], { required: true }),
    chargesEnabled: field.boolean({ required: true, default: false }),
    transfersEnabled: field.boolean({ required: true, default: false }),
    payoutsEnabled: field.boolean({ required: true, default: false }),
    requirementsDue: field.json({ optional: true }),
    requirementsPastDue: field.json({ optional: true }),
    disabledReason: field.string({ optional: true }),
    livemode: field.boolean({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [
    { columns: ['provider', 'providerAccountId'], unique: true },
    { columns: ['tenantId', 'ownerType', 'ownerId', 'provider', 'livemode'], unique: true },
  ],
});

export const paymentClientEntity = defineEntity({
  name: PaymentEntityName.Client,
  domain: 'payments',
  description: "A seller's (or the platform's) client, mirrored as a customer at the provider",
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: merchantRelation(true),
    provider: field.string({ required: true }),
    providerClientId: field.string({ required: true }),
    onPlatform: field.boolean({ required: true, default: false }),
    reference: field.string({ optional: true }),
    userId: field.string({ optional: true }),
    email: field.string({ optional: true, classification: 'personal', maskedInLogs: true }),
    name: field.string({ optional: true, classification: 'personal', maskedInLogs: true }),
  },
  indexes: [
    { columns: ['provider', 'providerClientId'], unique: true },
    ['merchantAccountId', 'reference'],
    ['merchantAccountId', 'email'],
  ],
});

export const paymentChargeEntity = defineEntity({
  name: PaymentEntityName.Charge,
  domain: 'payments',
  description: 'One request for money from a client (to a seller, or to the platform)',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: merchantRelation(true),
    clientId: field.relation({
      entity: PaymentEntityName.Client,
      type: 'many-to-one',
      optional: true,
    }),
    provider: field.string({ required: true }),
    flow: field.enum(FLOWS, { required: true, default: 'direct' }),
    collection: field.enum(['checkout', 'invoice', 'saved_method', 'link'], {
      required: true,
      default: 'checkout',
    }),
    ui: field.enum(['hosted', 'embedded'], { optional: true }),
    capture: field.enum(['automatic', 'manual'], { required: true, default: 'automatic' }),
    providerChargeId: field.string({ required: true }),
    providerPaymentId: field.string({ optional: true }),
    requestId: field.string({ optional: true }),
    status: field.enum(CHARGE_STATUSES, { required: true }),
    amount: field.bigint({ required: true }),
    customAmount: field.boolean({ required: true, default: false }),
    amountTotal: field.bigint({ optional: true }),
    amountDiscount: field.bigint({ required: true, default: 0 }),
    amountTax: field.bigint({ required: true, default: 0 }),
    currency: field.string({ required: true }),
    platformFeeAmount: field.bigint({ required: true, default: 0 }),
    amountRefunded: field.bigint({ required: true, default: 0 }),
    amountCapturable: field.bigint({ required: true, default: 0 }),
    captureBefore: field.timestamp({ optional: true }),
    description: field.string({ required: true }),
    items: field.json({ optional: true }),
    url: field.string({ optional: true, classification: 'internal' }),
    clientSecret: field.string({ optional: true, classification: 'internal' }),
    expiresAt: field.timestamp({ optional: true }),
    paidAt: field.timestamp({ optional: true }),
    clientEmail: field.string({ optional: true, classification: 'personal', maskedInLogs: true }),
    paymentMethodId: field.string({ optional: true }),
    saveMethod: field.boolean({ required: true, default: false }),
    failureCode: field.string({ optional: true }),
    transferGroup: field.string({ optional: true }),
    linkId: field.string({ optional: true }),
    billingCustomerId: field.string({ optional: true }),
    createdBy: field.string({ optional: true }),
    metadata: field.json({ optional: true }),
    livemode: field.boolean({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [
    { columns: ['provider', 'providerChargeId'], unique: true },
    { columns: ['merchantAccountId', 'requestId'], unique: true },
    ['providerPaymentId'],
    ['merchantAccountId', 'status'],
    ['transferGroup'],
    ['linkId'],
  ],
});

export const paymentRefundEntity = defineEntity({
  name: PaymentEntityName.Refund,
  domain: 'payments',
  description: 'Money returned to a client for a charge',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    chargeId: field.relation({ entity: PaymentEntityName.Charge, type: 'many-to-one' }),
    merchantAccountId: merchantRelation(true),
    provider: field.string({ required: true }),
    providerRefundId: field.string({ required: true }),
    requestId: field.string({ optional: true }),
    amount: field.bigint({ required: true }),
    currency: field.string({ required: true }),
    status: field.enum(['pending', 'requires_action', 'succeeded', 'failed', 'canceled'], {
      required: true,
    }),
    reason: field.string({ optional: true }),
    failureReason: field.string({ optional: true }),
    requestedBy: field.string({ optional: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [
    { columns: ['provider', 'providerRefundId'], unique: true },
    { columns: ['chargeId', 'requestId'], unique: true },
  ],
});

export const paymentDisputeEntity = defineEntity({
  name: PaymentEntityName.Dispute,
  domain: 'payments',
  description: 'A client disputing a charge with their bank',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    chargeId: field.relation({
      entity: PaymentEntityName.Charge,
      type: 'many-to-one',
      optional: true,
    }),
    merchantAccountId: merchantRelation(true),
    provider: field.string({ required: true }),
    providerDisputeId: field.string({ required: true }),
    providerPaymentId: field.string({ required: true }),
    amount: field.bigint({ required: true }),
    currency: field.string({ required: true }),
    status: field.enum(['needs_response', 'under_review', 'won', 'lost', 'closed'], {
      required: true,
    }),
    providerStatus: field.string({ required: true }),
    reason: field.string({ optional: true }),
    evidenceDueBy: field.timestamp({ optional: true }),
    evidenceSubmitted: field.boolean({ required: true, default: false }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [{ columns: ['provider', 'providerDisputeId'], unique: true }, ['chargeId']],
});

export const paymentMethodEntity = defineEntity({
  name: PaymentEntityName.Method,
  domain: 'payments',
  description: "A client's saved payment method (brand and last digits only)",
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    clientId: field.relation({ entity: PaymentEntityName.Client, type: 'many-to-one' }),
    merchantAccountId: merchantRelation(true),
    provider: field.string({ required: true }),
    providerMethodId: field.string({ required: true }),
    type: field.string({ required: true }),
    brand: field.string({ optional: true }),
    last4: field.string({ optional: true }),
    expMonth: field.number({ optional: true }),
    expYear: field.number({ optional: true }),
    status: field.enum(['active', 'removed'], { required: true, default: 'active' }),
  },
  indexes: [{ columns: ['provider', 'providerMethodId'], unique: true }, ['clientId']],
});

export const paymentSubscriptionEntity = defineEntity({
  name: PaymentEntityName.Subscription,
  domain: 'payments',
  description: "A recurring payment: a seller's client, or a customer of the platform's plans",
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    payee: field.enum(['seller', 'platform'], { required: true }),
    merchantAccountId: merchantRelation(true),
    clientId: field.relation({
      entity: PaymentEntityName.Client,
      type: 'many-to-one',
      optional: true,
    }),
    billingCustomerId: field.string({ optional: true }),
    flow: field.enum(FLOWS, { required: true }),
    provider: field.string({ required: true }),
    providerSubscriptionId: field.string({ required: true }),
    providerCheckoutId: field.string({ optional: true }),
    requestId: field.string({ optional: true }),
    plan: field.string({ optional: true }),
    planPrice: field.string({ optional: true }),
    status: field.enum(SUBSCRIPTION_STATUSES, { required: true }),
    currency: field.string({ required: true }),
    items: field.json({ optional: true }),
    quantity: field.number({ required: true, default: 1 }),
    currentPeriodEnd: field.timestamp({ optional: true }),
    cancelAtPeriodEnd: field.boolean({ required: true, default: false }),
    canceledAt: field.timestamp({ optional: true }),
    endedAt: field.timestamp({ optional: true }),
    trialEnd: field.timestamp({ optional: true }),
    applicationFeePercent: field.decimal({ optional: true }),
    checkoutUrl: field.string({ optional: true, classification: 'internal' }),
    checkoutExpiresAt: field.timestamp({ optional: true }),
    latestInvoiceId: field.string({ optional: true }),
    createdBy: field.string({ optional: true }),
    metadata: field.json({ optional: true }),
    livemode: field.boolean({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [
    { columns: ['provider', 'providerSubscriptionId'], unique: true },
    ['merchantAccountId', 'status'],
    ['billingCustomerId', 'status'],
    ['clientId'],
  ],
});

export const paymentInvoiceEntity = defineEntity({
  name: PaymentEntityName.Invoice,
  domain: 'payments',
  description: 'An invoice a subscription produced',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    subscriptionId: field.relation({
      entity: PaymentEntityName.Subscription,
      type: 'many-to-one',
      optional: true,
    }),
    merchantAccountId: merchantRelation(true),
    billingCustomerId: field.string({ optional: true }),
    provider: field.string({ required: true }),
    providerInvoiceId: field.string({ required: true }),
    status: field.enum(['draft', 'open', 'paid', 'void', 'uncollectible'], { required: true }),
    currency: field.string({ required: true }),
    amountDue: field.bigint({ required: true, default: 0 }),
    amountPaid: field.bigint({ required: true, default: 0 }),
    amountRemaining: field.bigint({ required: true, default: 0 }),
    hostedUrl: field.string({ optional: true, classification: 'internal' }),
    pdfUrl: field.string({ optional: true, classification: 'internal' }),
    number: field.string({ optional: true }),
    dueDate: field.timestamp({ optional: true }),
    periodStart: field.timestamp({ optional: true }),
    periodEnd: field.timestamp({ optional: true }),
    billingReason: field.string({ optional: true }),
    attemptCount: field.number({ required: true, default: 0 }),
    livemode: field.boolean({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [{ columns: ['provider', 'providerInvoiceId'], unique: true }, ['subscriptionId']],
});

export const paymentLinkEntity = defineEntity({
  name: PaymentEntityName.Link,
  domain: 'payments',
  description: "A seller's reusable payment link; each payment through it becomes a charge",
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: merchantRelation(),
    provider: field.string({ required: true }),
    providerLinkId: field.string({ required: true }),
    flow: field.enum(FLOWS, { required: true }),
    url: field.string({ optional: true }),
    active: field.boolean({ required: true, default: true }),
    currency: field.string({ required: true }),
    items: field.json({ required: true }),
    customAmount: field.boolean({ required: true, default: false }),
    platformFeeAmount: field.bigint({ required: true, default: 0 }),
    description: field.string({ required: true }),
    createdBy: field.string({ optional: true }),
    metadata: field.json({ optional: true }),
    livemode: field.boolean({ required: true }),
  },
  indexes: [{ columns: ['provider', 'providerLinkId'], unique: true }, ['merchantAccountId']],
});

export const paymentTransferEntity = defineEntity({
  name: PaymentEntityName.Transfer,
  domain: 'payments',
  description: 'Money the platform sent to a seller from its own balance',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: merchantRelation(),
    chargeId: field.relation({
      entity: PaymentEntityName.Charge,
      type: 'many-to-one',
      optional: true,
    }),
    provider: field.string({ required: true }),
    providerTransferId: field.string({ required: true }),
    requestId: field.string({ optional: true }),
    amount: field.bigint({ required: true }),
    currency: field.string({ required: true }),
    amountReversed: field.bigint({ required: true, default: 0 }),
    transferGroup: field.string({ optional: true }),
    description: field.string({ optional: true }),
    metadata: field.json({ optional: true }),
    livemode: field.boolean({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [
    { columns: ['provider', 'providerTransferId'], unique: true },
    { columns: ['merchantAccountId', 'requestId'], unique: true },
    ['chargeId'],
  ],
});

export const paymentPayoutEntity = defineEntity({
  name: PaymentEntityName.Payout,
  domain: 'payments',
  description: "A payout from a seller's balance to their bank account or card",
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: merchantRelation(),
    provider: field.string({ required: true }),
    providerPayoutId: field.string({ required: true }),
    amount: field.bigint({ required: true }),
    currency: field.string({ required: true }),
    status: field.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled'], {
      required: true,
    }),
    method: field.enum(['standard', 'instant'], { required: true }),
    arrivalDate: field.timestamp({ optional: true }),
    failureCode: field.string({ optional: true }),
    livemode: field.boolean({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [
    { columns: ['provider', 'providerPayoutId'], unique: true },
    ['merchantAccountId', 'status'],
  ],
});

export const paymentBillingCustomerEntity = defineEntity({
  name: PaymentEntityName.BillingCustomer,
  domain: 'payments',
  description: 'Who the platform bills for its own plans: a tenant, a user, or a seller',
  tenantScoped: true,
  fields: {
    id: field.id(),
    tenantId: field.string({ required: true }),
    ownerType: field.enum(['tenant', 'user', 'seller'], { required: true }),
    ownerId: field.string({ required: true }),
    provider: field.string({ required: true }),
    providerCustomerId: field.string({ required: true }),
    email: field.string({ optional: true, classification: 'personal', maskedInLogs: true }),
    livemode: field.boolean({ required: true }),
  },
  indexes: [
    { columns: ['provider', 'providerCustomerId'], unique: true },
    { columns: ['tenantId', 'ownerType', 'ownerId', 'provider', 'livemode'], unique: true },
  ],
});

export const paymentEntitlementEntity = defineEntity({
  name: PaymentEntityName.Entitlement,
  domain: 'payments',
  description: 'A plan feature a billing customer currently has',
  tenantScoped: true,
  fields: {
    id: field.id(),
    billingCustomerId: field.relation({
      entity: PaymentEntityName.BillingCustomer,
      type: 'many-to-one',
    }),
    provider: field.string({ required: true }),
    feature: field.string({ required: true }),
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [{ columns: ['billingCustomerId', 'feature'], unique: true }],
});

/**
 * Ledger of verified webhook deliveries. Not tenant-scoped: some events belong
 * to no seller, and the row is written before tenant work starts. Only the
 * payments service account reads or writes it.
 */
export const paymentProviderEventEntity = defineEntity({
  name: PaymentEntityName.ProviderEvent,
  domain: 'payments',
  description: 'Verified payment-provider webhook deliveries (dedupe + processing ledger)',
  tenantScoped: false,
  retention: { duration: '90d' },
  fields: {
    id: field.id(),
    tenantId: field.string({ optional: true }),
    provider: field.string({ required: true }),
    providerEventId: field.string({ required: true }),
    type: field.string({ required: true }),
    format: field.enum(['snapshot', 'thin'], { required: true }),
    livemode: field.boolean({ required: true }),
    providerAccountId: field.string({ optional: true }),
    merchantAccountId: field.string({ optional: true }),
    objectId: field.string({ optional: true }),
    objectType: field.string({ optional: true }),
    status: field.enum(['received', 'processed', 'ignored', 'failed'], { required: true }),
    ignoredReason: field.string({ optional: true }),
    error: field.string({ optional: true }),
    occurredAt: field.timestamp({ required: true }),
    receivedAt: field.timestamp({ required: true }),
    processedAt: field.timestamp({ optional: true }),
    payload: field.json({ optional: true, classification: 'personal' }),
  },
  indexes: [{ columns: ['provider', 'providerEventId'], unique: true }, ['status', 'receivedAt']],
});

/** All payments entities, in registration order. Register every one, used or not. */
export const paymentEntities = [
  paymentMerchantAccountEntity,
  paymentClientEntity,
  paymentChargeEntity,
  paymentRefundEntity,
  paymentDisputeEntity,
  paymentMethodEntity,
  paymentSubscriptionEntity,
  paymentInvoiceEntity,
  paymentLinkEntity,
  paymentTransferEntity,
  paymentPayoutEntity,
  paymentBillingCustomerEntity,
  paymentEntitlementEntity,
  paymentProviderEventEntity,
] as const;
