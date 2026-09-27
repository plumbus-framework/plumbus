// ── Payments entities ──
// Local copies of provider state. The provider stays the source of truth;
// these rows make seller screens, access checks, and reports fast and let app
// code read payments through ctx.data. Register every entity in app/entities.
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
  ProviderEvent: 'PaymentProviderEvent',
} as const;

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
    feesCollector: field.enum(['provider', 'platform'], { required: true }),
    lossesCollector: field.enum(['provider', 'platform'], { required: true }),
    country: field.string({ optional: true }),
    defaultCurrency: field.string({ optional: true }),
    status: field.enum(['onboarding', 'active', 'restricted', 'closed'], { required: true }),
    chargesEnabled: field.boolean({ required: true, default: false }),
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
  description: "A seller's client, mirrored as a customer on the seller's provider account",
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: field.relation({
      entity: PaymentEntityName.MerchantAccount,
      type: 'many-to-one',
    }),
    provider: field.string({ required: true }),
    providerClientId: field.string({ required: true }),
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
  description: 'One request for money from a client to a seller',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    merchantAccountId: field.relation({
      entity: PaymentEntityName.MerchantAccount,
      type: 'many-to-one',
    }),
    clientId: field.relation({
      entity: PaymentEntityName.Client,
      type: 'many-to-one',
      optional: true,
    }),
    provider: field.string({ required: true }),
    providerChargeId: field.string({ required: true }),
    providerPaymentId: field.string({ optional: true }),
    requestId: field.string({ optional: true }),
    status: field.enum(['open', 'processing', 'paid', 'failed', 'expired'], { required: true }),
    amount: field.bigint({ required: true }),
    currency: field.string({ required: true }),
    platformFeeAmount: field.bigint({ required: true, default: 0 }),
    amountRefunded: field.bigint({ required: true, default: 0 }),
    description: field.string({ required: true }),
    url: field.string({ optional: true, classification: 'internal' }),
    expiresAt: field.timestamp({ optional: true }),
    paidAt: field.timestamp({ optional: true }),
    clientEmail: field.string({ optional: true, classification: 'personal', maskedInLogs: true }),
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
    merchantAccountId: field.relation({
      entity: PaymentEntityName.MerchantAccount,
      type: 'many-to-one',
    }),
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
    merchantAccountId: field.relation({
      entity: PaymentEntityName.MerchantAccount,
      type: 'many-to-one',
    }),
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
    syncedAt: field.timestamp({ optional: true }),
  },
  indexes: [{ columns: ['provider', 'providerDisputeId'], unique: true }, ['chargeId']],
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

/** All payments entities, in registration order. */
export const paymentEntities = [
  paymentMerchantAccountEntity,
  paymentClientEntity,
  paymentChargeEntity,
  paymentRefundEntity,
  paymentDisputeEntity,
  paymentProviderEventEntity,
] as const;
