// ── Shared runtime for the payments capabilities ──
// Owner resolution, merchant lookup, fee math, metadata, and output views.
// Owners always come from the authenticated caller, never from input, so one
// seller can never act on another seller's account.

import type { ExecutionContext } from '@plumbus/core';
import type { NormalizedPaymentsConfig, PlatformFeeInput, SellerOwner } from '../types/config.js';
import type { PaymentProvider } from '../types/provider.js';
import type {
  PaymentChargeRow,
  PaymentMerchantAccountRow,
  PaymentRefundRow,
} from '../types/records.js';
import { findOne, merchantAccounts } from './repos.js';

/** Service account the webhook route and worker run as. List it nowhere else. */
export const PAYMENTS_WEBHOOK_ACTOR = 'payments-webhook';

export interface PaymentsRuntime {
  config: NormalizedPaymentsConfig;
  provider: PaymentProvider;
}

export interface Owner {
  tenantId: string;
  ownerType: SellerOwner;
  ownerId: string;
}

export function resolveOwner(ctx: ExecutionContext, runtime: PaymentsRuntime): Owner {
  const tenantId = ctx.auth.tenantId;
  if (!tenantId) {
    throw ctx.errors.forbidden('Payments need a tenant context (auth.tenantId)', {
      reason: 'payments_tenant_required',
    });
  }
  if (runtime.config.seller.owner === 'tenant') {
    return { tenantId, ownerType: 'tenant', ownerId: tenantId };
  }
  const userId = ctx.auth.userId;
  if (!userId) {
    throw ctx.errors.forbidden('Payments need a signed-in user', {
      reason: 'payments_user_required',
    });
  }
  return { tenantId, ownerType: 'user', ownerId: userId };
}

export async function findOwnMerchant(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: Owner,
): Promise<PaymentMerchantAccountRow | null> {
  const livemode = await runtime.provider.resolveLivemode();
  return findOne(merchantAccounts(ctx), {
    tenantId: owner.tenantId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    provider: runtime.provider.id,
    livemode,
  });
}

export async function requireOwnMerchant(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
): Promise<{ owner: Owner; merchant: PaymentMerchantAccountRow }> {
  const owner = resolveOwner(ctx, runtime);
  const merchant = await findOwnMerchant(ctx, runtime, owner);
  if (!merchant) {
    throw ctx.errors.notFound('No payment account is connected yet', {
      reason: 'payments_no_merchant_account',
    });
  }
  return { owner, merchant };
}

/** Metadata stamped on every provider object so it can be traced back to the app. */
export function ownerMetadata(
  runtime: PaymentsRuntime,
  owner: Pick<Owner, 'tenantId' | 'ownerType' | 'ownerId'>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    plumbus_tenant_id: owner.tenantId,
    plumbus_owner_type: owner.ownerType,
    plumbus_owner_id: owner.ownerId,
    ...(runtime.config.appId ? { plumbus_app: runtime.config.appId } : {}),
    ...extra,
  };
}

/** Compute the platform fee in minor units, exactly (integer math, half-up). */
export async function computePlatformFee(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  input: PlatformFeeInput,
): Promise<number> {
  const rule = runtime.config.platformFee;
  let fee = 0;
  if (typeof rule === 'function') {
    fee = await rule(input);
  } else if (rule) {
    fee = percentOf(input.amount, rule.percent ?? 0) + (rule.fixed?.[input.currency] ?? 0);
  }
  if (!Number.isSafeInteger(fee) || fee < 0) {
    throw ctx.errors.internal('platformFee must produce a non-negative whole number', {
      reason: 'payments_invalid_platform_fee',
      fee,
    });
  }
  if (fee > input.amount) {
    throw ctx.errors.validation('The platform fee would be larger than the charge', {
      reason: 'payments_fee_exceeds_amount',
      amount: input.amount,
      fee,
    });
  }
  return fee;
}

/** `amount × percent / 100`, rounded half-up, exact for any decimal percent. */
export function percentOf(amount: number, percent: number): number {
  if (percent === 0) return 0;
  // The shortest decimal that round-trips, e.g. 2.9 → 29 / 10, 5e-7 → 5 / 10^7.
  const [mantissa = '0', exponent = '0'] = percent.toString().toLowerCase().split('e');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  let digits = BigInt(whole + fraction);
  let places = fraction.length - Number(exponent);
  if (places < 0) {
    digits *= 10n ** BigInt(-places);
    places = 0;
  }
  const denominator = 100n * 10n ** BigInt(places);
  return Number((BigInt(amount) * digits * 2n + denominator) / (2n * denominator));
}

export function fillUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? encodeURIComponent(values[key] ?? '') : match,
  );
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

export function merchantView(row: PaymentMerchantAccountRow) {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    provider: row.provider,
    dashboard: row.dashboard,
    feesCollector: row.feesCollector,
    lossesCollector: row.lossesCollector,
    country: row.country ?? null,
    defaultCurrency: row.defaultCurrency ?? null,
    status: row.status,
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    requirementsDue: row.requirementsDue ?? [],
    requirementsPastDue: row.requirementsPastDue ?? [],
    disabledReason: row.disabledReason ?? null,
    livemode: row.livemode,
  };
}

export function chargeView(row: PaymentChargeRow) {
  return {
    id: row.id,
    merchantAccountId: row.merchantAccountId,
    clientId: row.clientId ?? null,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    platformFeeAmount: row.platformFeeAmount ?? 0,
    amountRefunded: row.amountRefunded ?? 0,
    description: row.description,
    url: row.status === 'open' ? (row.url ?? null) : null,
    expiresAt: iso(row.expiresAt),
    paidAt: iso(row.paidAt),
    clientEmail: row.clientEmail ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.createdAt),
    livemode: row.livemode,
  };
}

export function refundView(row: PaymentRefundRow) {
  return {
    id: row.id,
    chargeId: row.chargeId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: iso(row.createdAt),
  };
}

export const isoDate = iso;
