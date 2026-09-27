// ── Zod shapes shared by the payments capabilities ──

import { z } from '@plumbus/core/zod';
import type { ProviderStateChange } from '../types/provider.js';

export const dashboardSchema = z.enum(['full', 'express', 'none']);
export const merchantStatusSchema = z.enum(['onboarding', 'active', 'restricted', 'closed']);
export const chargeStatusSchema = z.enum(['open', 'processing', 'paid', 'failed', 'expired']);
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
export const responsibilitySchema = z.enum(['provider', 'platform']);
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
    (value) => Object.keys(value).every((key) => !key.startsWith('plumbus_')),
    'Metadata keys starting with "plumbus_" are reserved',
  );

export const merchantViewSchema = z.object({
  id: z.string(),
  ownerType: z.enum(['user', 'tenant']),
  ownerId: z.string(),
  provider: z.string(),
  dashboard: dashboardSchema,
  feesCollector: responsibilitySchema,
  lossesCollector: responsibilitySchema,
  country: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
  status: merchantStatusSchema,
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  requirementsDue: z.array(z.string()),
  requirementsPastDue: z.array(z.string()),
  disabledReason: z.string().nullable(),
  livemode: z.boolean(),
});

export const chargeViewSchema = z.object({
  id: z.string(),
  merchantAccountId: z.string(),
  clientId: z.string().nullable(),
  status: chargeStatusSchema,
  amount: z.number().int(),
  currency: z.string(),
  platformFeeAmount: z.number().int(),
  amountRefunded: z.number().int(),
  description: z.string(),
  url: z.string().nullable(),
  expiresAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  clientEmail: z.string().nullable(),
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

// ── Provider state changes, serialized for applyProviderState (dates as ISO) ──

const isoOrNull = z.string().nullable();

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
  accountId: z.string(),
  charge: z.object({
    id: z.string(),
    reference: z.string().nullable(),
    paymentId: z.string().nullable(),
    status: chargeStatusSchema,
    amount: z.number().int(),
    currency: z.string(),
    platformFeeAmount: z.number().int().nullable(),
    amountRefunded: z.number().int().nullable(),
    url: z.string().nullable(),
    expiresAt: isoOrNull,
    paidAt: isoOrNull,
    clientEmail: z.string().nullable(),
    livemode: z.boolean(),
  }),
});

const refundChange = z.object({
  kind: z.literal('refund'),
  accountId: z.string(),
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
  accountId: z.string(),
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
  }),
});

export const stateChangeSchema = z.discriminatedUnion('kind', [
  merchantChange,
  chargeChange,
  refundChange,
  disputeChange,
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
  }
}
