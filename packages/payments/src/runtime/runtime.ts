// ── Shared runtime for the payments capabilities ──
// Owner resolution, merchant lookup, charge routing, fee math, metadata, and
// output views. Owners always come from the authenticated caller, never from
// input, so one seller can never act on another seller's account.

import type { ExecutionContext } from '@plumbus/core';
import type {
  BillingCustomerKind,
  FeeMerchant,
  NormalizedPaymentsConfig,
  PlatformFeeInput,
  SellerOwner,
  SubscriptionFeeInput,
} from '../types/config.js';
import type { ChargeRouting, ChargeType, PaymentProvider } from '../types/provider.js';
import type {
  PaymentChargeRow,
  PaymentClientRow,
  PaymentDisputeRow,
  PaymentInvoiceRow,
  PaymentLinkRow,
  PaymentMerchantAccountRow,
  PaymentMethodRow,
  PaymentPayoutRow,
  PaymentRefundRow,
  PaymentSubscriptionRow,
  PaymentTransferRow,
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

export interface BillingOwner {
  tenantId: string;
  ownerType: BillingCustomerKind;
  ownerId: string;
}

function requireTenant(ctx: ExecutionContext): string {
  const tenantId = ctx.auth.tenantId;
  if (!tenantId) {
    throw ctx.errors.forbidden('Payments need a tenant context (auth.tenantId)', {
      reason: 'payments_tenant_required',
    });
  }
  return tenantId;
}

function requireUser(ctx: ExecutionContext): string {
  const userId = ctx.auth.userId;
  if (!userId) {
    throw ctx.errors.forbidden('Payments need a signed-in user', {
      reason: 'payments_user_required',
    });
  }
  return userId;
}

export function resolveOwner(ctx: ExecutionContext, runtime: PaymentsRuntime): Owner {
  const tenantId = requireTenant(ctx);
  if (runtime.config.seller?.owner === 'tenant') {
    return { tenantId, ownerType: 'tenant', ownerId: tenantId };
  }
  return { tenantId, ownerType: 'user', ownerId: requireUser(ctx) };
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

/** The billing customer identity of the caller, for the platform's own plans. */
export async function resolveBillingOwner(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
): Promise<BillingOwner> {
  const tenantId = requireTenant(ctx);
  const kind = runtime.config.billing?.customer ?? 'tenant';
  if (kind === 'tenant') return { tenantId, ownerType: 'tenant', ownerId: tenantId };
  if (kind === 'user') return { tenantId, ownerType: 'user', ownerId: requireUser(ctx) };
  const { merchant } = await requireOwnMerchant(ctx, runtime);
  return { tenantId, ownerType: 'seller', ownerId: merchant.id };
}

/** Provider abilities to request for a new seller: their charge type's, plus transfers when on. */
export function requestedCapabilities(
  runtime: PaymentsRuntime,
  chargeType: ChargeType,
): { cardPayments: boolean; transfers: boolean } {
  const required = requiredCapabilities(runtime, chargeType);
  return { ...required, transfers: required.transfers || runtime.config.transfers.enabled };
}

/** Provider abilities a seller needs before their charge type can take payments. */
export function requiredCapabilities(
  runtime: PaymentsRuntime,
  chargeType: ChargeType,
): { cardPayments: boolean; transfers: boolean } {
  return chargeType === 'destination'
    ? { cardPayments: runtime.config.destination.onBehalfOf, transfers: true }
    : { cardPayments: true, transfers: false };
}

/** The seller can be paid through their charge type right now. */
export function canTakePayments(
  runtime: PaymentsRuntime,
  merchant: Pick<PaymentMerchantAccountRow, 'chargeType' | 'chargesEnabled' | 'transfersEnabled'>,
): boolean {
  const needs = requiredCapabilities(runtime, merchant.chargeType ?? 'direct');
  return (
    (!needs.cardPayments || merchant.chargesEnabled) &&
    (!needs.transfers || merchant.transfersEnabled === true)
  );
}

/** Where a seller's charge is created and who is paid. */
export function sellerRouting(
  runtime: PaymentsRuntime,
  merchant: Pick<PaymentMerchantAccountRow, 'chargeType' | 'providerAccountId'>,
): ChargeRouting {
  const flow = merchant.chargeType ?? 'direct';
  return {
    flow,
    sellerAccountId: merchant.providerAccountId,
    onBehalfOf: flow === 'destination' && runtime.config.destination.onBehalfOf,
    transferGroup: null,
  };
}

export const PLATFORM_ROUTING: ChargeRouting = {
  flow: 'platform',
  sellerAccountId: null,
  onBehalfOf: false,
  transferGroup: null,
};

/** Routing of a stored charge (and its refunds, captures, disputes). */
export function chargeRouting(
  charge: Pick<PaymentChargeRow, 'flow' | 'transferGroup'>,
  merchant: Pick<PaymentMerchantAccountRow, 'providerAccountId'> | null,
  runtime: PaymentsRuntime,
): ChargeRouting {
  const flow = charge.flow ?? 'direct';
  return {
    flow,
    sellerAccountId: merchant?.providerAccountId ?? null,
    onBehalfOf: flow === 'destination' && runtime.config.destination.onBehalfOf,
    transferGroup: charge.transferGroup ?? null,
  };
}

/** The account a provider object lives on: the seller for direct charges, else the platform. */
export function objectAccount(routing: ChargeRouting): string | null {
  return routing.flow === 'direct' ? routing.sellerAccountId : null;
}

/** Metadata stamped on every provider object so it can be traced back to the app. */
export function ownerMetadata(
  runtime: PaymentsRuntime,
  owner: { tenantId: string; ownerType: string; ownerId: string },
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

/** The app's own metadata plus ours (ours wins; app keys may not start with `plumbus_`). */
export function withAppMetadata(
  ours: Record<string, string>,
  app: Record<string, string> | null | undefined,
): Record<string, string> {
  return { ...(app ?? {}), ...ours };
}

export function feeMerchant(merchant: PaymentMerchantAccountRow): FeeMerchant {
  return {
    id: merchant.id,
    ownerType: merchant.ownerType,
    ownerId: merchant.ownerId,
    dashboard: merchant.dashboard,
    feesCollector: merchant.feesCollector,
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

/** Your cut of a subscription payment, in percent with at most two decimals. */
export async function computeSubscriptionFee(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  input: SubscriptionFeeInput,
): Promise<number> {
  const rule = runtime.config.subscriptions.platformFeePercent;
  const percent = typeof rule === 'function' ? await rule(input) : rule;
  if (
    typeof percent !== 'number' ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    Math.round(percent * 100) !== percent * 100
  ) {
    throw ctx.errors.internal(
      'subscriptions.platformFeePercent must be 0–100 with at most two decimals',
      { reason: 'payments_invalid_subscription_fee', percent },
    );
  }
  return percent;
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
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? encodeURIComponent(values[name] ?? '') : match,
  );
}

type UrlName = keyof NormalizedPaymentsConfig['urls'];

/** A configured redirect URL, or a validation error naming the option to set. */
export function requireUrl(ctx: ExecutionContext, runtime: PaymentsRuntime, name: UrlName): string {
  const url = runtime.config.urls[name];
  if (!url) {
    throw ctx.errors.validation(`Set urls.${name} in createPayments() to use this`, {
      reason: 'payments_url_missing',
      url: name,
    });
  }
  return url;
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

export const isoDate = iso;

export function merchantView(row: PaymentMerchantAccountRow) {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    provider: row.provider,
    dashboard: row.dashboard,
    chargeType: row.chargeType ?? 'direct',
    feesCollector: row.feesCollector,
    lossesCollector: row.lossesCollector,
    country: row.country ?? null,
    defaultCurrency: row.defaultCurrency ?? null,
    status: row.status,
    chargesEnabled: row.chargesEnabled,
    transfersEnabled: row.transfersEnabled ?? false,
    payoutsEnabled: row.payoutsEnabled,
    requirementsDue: row.requirementsDue ?? [],
    requirementsPastDue: row.requirementsPastDue ?? [],
    disabledReason: row.disabledReason ?? null,
    livemode: row.livemode,
  };
}

/** Whether the client can still act on the charge's payment page. */
function payable(row: PaymentChargeRow): boolean {
  return row.status === 'open' || row.status === 'requires_action';
}

export interface ChargeViewContext {
  publishableKey?: string | null;
  /** Seller account the front end passes to the provider SDK (direct charges). */
  sellerAccountId?: string | null;
}

export function chargeView(row: PaymentChargeRow, context: ChargeViewContext = {}) {
  const embedded = row.ui === 'embedded' && payable(row) && row.clientSecret;
  return {
    id: row.id,
    merchantAccountId: row.merchantAccountId ?? null,
    clientId: row.clientId ?? null,
    flow: row.flow ?? 'direct',
    collection: row.collection ?? 'checkout',
    capture: row.capture ?? 'automatic',
    status: row.status,
    amount: row.amount,
    customAmount: row.customAmount ?? false,
    amountTotal: row.amountTotal ?? null,
    amountDiscount: row.amountDiscount ?? 0,
    amountTax: row.amountTax ?? 0,
    currency: row.currency,
    platformFeeAmount: row.platformFeeAmount ?? 0,
    amountRefunded: row.amountRefunded ?? 0,
    amountCapturable: row.amountCapturable ?? 0,
    captureBefore: iso(row.captureBefore),
    description: row.description,
    items: (row.items ?? []).map((item) => ({
      name: item.name,
      description: item.description ?? null,
      unitAmount: item.unitAmount,
      quantity: item.quantity,
    })),
    url: payable(row) && row.ui !== 'embedded' ? (row.url ?? null) : null,
    checkout: embedded
      ? {
          clientSecret: row.clientSecret as string,
          publishableKey: context.publishableKey ?? null,
          accountId: row.flow === 'direct' ? (context.sellerAccountId ?? null) : null,
        }
      : null,
    expiresAt: iso(row.expiresAt),
    paidAt: iso(row.paidAt),
    clientEmail: row.clientEmail ?? null,
    paymentMethodId: row.paymentMethodId ?? null,
    failureCode: row.failureCode ?? null,
    linkId: row.linkId ?? null,
    transferGroup: row.transferGroup ?? null,
    billingCustomerId: row.billingCustomerId ?? null,
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

export function disputeView(row: PaymentDisputeRow) {
  return {
    id: row.id,
    chargeId: row.chargeId ?? null,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason ?? null,
    evidenceDueBy: iso(row.evidenceDueBy),
    evidenceSubmitted: row.evidenceSubmitted ?? false,
    createdAt: iso(row.createdAt),
  };
}

export function clientView(row: PaymentClientRow) {
  return {
    id: row.id,
    reference: row.reference ?? null,
    userId: row.userId ?? null,
    email: row.email ?? null,
    name: row.name ?? null,
    createdAt: iso(row.createdAt),
  };
}

export function paymentMethodView(row: PaymentMethodRow) {
  return {
    id: row.id,
    clientId: row.clientId,
    type: row.type,
    brand: row.brand ?? null,
    last4: row.last4 ?? null,
    expMonth: row.expMonth ?? null,
    expYear: row.expYear ?? null,
    status: row.status,
  };
}

export function subscriptionView(row: PaymentSubscriptionRow) {
  const waiting = row.status === 'incomplete' && row.checkoutUrl;
  return {
    id: row.id,
    payee: row.payee,
    merchantAccountId: row.merchantAccountId ?? null,
    clientId: row.clientId ?? null,
    billingCustomerId: row.billingCustomerId ?? null,
    plan: row.plan ?? null,
    planPrice: row.planPrice ?? null,
    status: row.status,
    currency: row.currency,
    items: row.items ?? [],
    quantity: row.quantity ?? 1,
    currentPeriodEnd: iso(row.currentPeriodEnd),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
    canceledAt: iso(row.canceledAt),
    trialEnd: iso(row.trialEnd),
    checkoutUrl: waiting ? (row.checkoutUrl ?? null) : null,
    createdAt: iso(row.createdAt),
    livemode: row.livemode,
  };
}

export function invoiceView(row: PaymentInvoiceRow) {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId ?? null,
    status: row.status,
    currency: row.currency,
    amountDue: row.amountDue ?? 0,
    amountPaid: row.amountPaid ?? 0,
    amountRemaining: row.amountRemaining ?? 0,
    hostedUrl: row.hostedUrl ?? null,
    pdfUrl: row.pdfUrl ?? null,
    number: row.number ?? null,
    dueDate: iso(row.dueDate),
    periodStart: iso(row.periodStart),
    periodEnd: iso(row.periodEnd),
  };
}

export function linkView(row: PaymentLinkRow) {
  return {
    id: row.id,
    url: row.active ? (row.url ?? null) : null,
    active: row.active,
    currency: row.currency,
    description: row.description,
    items: (row.items ?? []).map((item) => ({
      name: item.name,
      description: item.description ?? null,
      unitAmount: item.unitAmount,
      quantity: item.quantity,
      adjustableQuantity: item.adjustableQuantity ?? null,
    })),
    customAmount: row.customAmount ?? false,
    platformFeeAmount: row.platformFeeAmount ?? 0,
    createdAt: iso(row.createdAt),
  };
}

export function transferView(row: PaymentTransferRow) {
  return {
    id: row.id,
    merchantAccountId: row.merchantAccountId,
    chargeId: row.chargeId ?? null,
    amount: row.amount,
    amountReversed: row.amountReversed ?? 0,
    currency: row.currency,
    transferGroup: row.transferGroup ?? null,
    description: row.description ?? null,
    createdAt: iso(row.createdAt),
  };
}

export function payoutView(row: PaymentPayoutRow) {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    method: row.method,
    arrivalDate: iso(row.arrivalDate),
    failureCode: row.failureCode ?? null,
    createdAt: iso(row.createdAt),
  };
}
