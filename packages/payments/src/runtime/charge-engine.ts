// ── Charge engine ──
// Creating, sending, capturing, canceling, and refunding charges, shared by the
// seller capabilities and the platform helpers. Rows are saved before every
// provider call (with a `pending:` provider id) so webhooks that race the
// response find them, and stamped with the time the call started so state a
// worker reads meanwhile is never taken for older.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { PaymentEventName } from '../events/index.js';
import type {
  CaptureMode,
  ChargeCollection,
  ChargeItem,
  ChargeRouting,
  ChargeStatus,
  CheckoutOptions,
  CheckoutUi,
  CreateRefundInput,
  CustomAmount,
  ProviderCharge,
} from '../types/provider.js';
import type {
  PaymentChargeRow,
  PaymentClientRow,
  PaymentMerchantAccountRow,
  PaymentMethodRow,
  PaymentRefundRow,
} from '../types/records.js';
import {
  charges,
  findOne,
  isPendingProviderId,
  PENDING_PROVIDER_ID,
  refunds,
  stableUuid,
  type TypedRepo,
} from './repos.js';
import {
  chargeRouting,
  fillUrl,
  ownerMetadata,
  type PaymentsRuntime,
  refundView,
  withAppMetadata,
} from './runtime.js';

// How long a refund may wait for its provider id before it counts as lost. Provider
// calls give up well before this (timeouts and retries take a few minutes at most).
const STALE_PENDING_MS = 15 * 60_000;

/** Who is paid, and whose name goes into provider metadata. */
export interface ChargeParty {
  tenantId: string;
  /** The seller paid, or null for platform charges. */
  merchant: PaymentMerchantAccountRow | null;
  owner: { tenantId: string; ownerType: string; ownerId: string };
  routing: ChargeRouting;
  billingCustomerId: string | null;
}

export interface ChargeRequest {
  collection: Exclude<ChargeCollection, 'link'>;
  ui: CheckoutUi | null;
  capture: CaptureMode;
  saveMethod: boolean;
  items: ChargeItem[];
  customAmount: CustomAmount | null;
  description: string;
  currency: string;
  platformFeeAmount: number;
  client: PaymentClientRow | null;
  /** Bill this provider customer when there is no client row (the platform's billing customers). */
  providerCustomerId?: string;
  clientEmail: string | null;
  requestId: string | null;
  metadata: Record<string, string> | null;
  options: CheckoutOptions;
  dueInDays: number | null;
  paymentMethod: PaymentMethodRow | null;
  createdBy: string | null;
}

export function itemsTotal(items: readonly ChargeItem[]): number {
  return items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
}

/** Config defaults under per-charge overrides. */
export function checkoutOptions(
  runtime: PaymentsRuntime,
  override: CheckoutOptions = {},
): CheckoutOptions {
  const c = runtime.config.checkout;
  const merged: CheckoutOptions = {
    allowPromotionCodes: override.allowPromotionCodes ?? c.allowPromotionCodes,
    automaticTax: override.automaticTax ?? c.automaticTax,
    phone: override.phone ?? c.phone,
  };
  const billingAddress = override.billingAddress ?? c.billingAddress;
  const shippingCountries = override.shippingCountries ?? c.shippingCountries;
  const locale = override.locale ?? c.locale;
  const submitType = override.submitType ?? c.submitType;
  if (billingAddress) merged.billingAddress = billingAddress;
  if (shippingCountries) merged.shippingCountries = shippingCountries;
  if (locale) merged.locale = locale;
  if (submitType) merged.submitType = submitType;
  if (override.statementDescriptorSuffix) {
    merged.statementDescriptorSuffix = override.statementDescriptorSuffix;
  }
  return merged;
}

export function chargeEventBase(row: PaymentChargeRow, merchant: PaymentMerchantAccountRow | null) {
  return {
    merchantAccountId: merchant?.id ?? null,
    ownerType: merchant?.ownerType ?? null,
    ownerId: merchant?.ownerId ?? null,
    chargeId: row.id,
    flow: row.flow ?? 'direct',
    amount: row.amount,
    currency: row.currency,
    clientId: row.clientId ?? null,
    billingCustomerId: row.billingCustomerId ?? null,
  };
}

/** Emit the event for a status a charge just reached; returns how many were emitted. */
export async function emitChargeStatus(
  ctx: ExecutionContext,
  row: PaymentChargeRow,
  previous: ChargeStatus,
  merchant: PaymentMerchantAccountRow | null,
): Promise<number> {
  if (row.status === previous) return 0;
  const base = chargeEventBase(row, merchant);
  switch (row.status) {
    case 'paid':
      await ctx.events.emit(PaymentEventName.ChargePaid, {
        ...base,
        amountTotal: row.amountTotal ?? row.amount,
        platformFeeAmount: row.platformFeeAmount ?? 0,
        linkId: row.linkId ?? null,
        paidAt: new Date(row.paidAt ?? ctx.time.now()).toISOString(),
      });
      return 1;
    case 'authorized':
      await ctx.events.emit(PaymentEventName.ChargeAuthorized, {
        ...base,
        amountCapturable: row.amountCapturable || row.amount,
        captureBefore: row.captureBefore ? new Date(row.captureBefore).toISOString() : null,
      });
      return 1;
    case 'requires_action':
      await ctx.events.emit(PaymentEventName.ChargeActionRequired, {
        ...base,
        url: row.url ?? null,
        failureCode: row.failureCode ?? null,
      });
      return 1;
    case 'failed':
      await ctx.events.emit(PaymentEventName.ChargeFailed, {
        ...base,
        failureCode: row.failureCode ?? null,
      });
      return 1;
    case 'expired':
      await ctx.events.emit(PaymentEventName.ChargeExpired, base);
      return 1;
    case 'canceled':
      await ctx.events.emit(PaymentEventName.ChargeCanceled, base);
      return 1;
    default:
      return 0;
  }
}

export async function emitChargeCreated(
  ctx: ExecutionContext,
  row: PaymentChargeRow,
  merchant: PaymentMerchantAccountRow | null,
): Promise<void> {
  await ctx.events.emit(PaymentEventName.ChargeCreated, {
    ...chargeEventBase(row, merchant),
    collection: row.collection ?? 'checkout',
    platformFeeAmount: row.platformFeeAmount ?? 0,
    createdBy: row.createdBy ?? null,
  });
}

/** Save a charge before calling the provider: webhooks that race the call find this row. */
export async function insertCharge(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  party: ChargeParty,
  request: ChargeRequest,
  chargeId: string = randomUUID(),
): Promise<PaymentChargeRow> {
  const expiresAt =
    request.collection === 'checkout'
      ? new Date(ctx.time.now().getTime() + runtime.config.checkout.expiresAfterMinutes * 60_000)
      : null;
  const amount = request.customAmount
    ? (request.customAmount.preset ?? request.customAmount.minimum ?? 0)
    : itemsTotal(request.items);
  return charges(ctx).create({
    id: chargeId,
    tenantId: party.tenantId,
    merchantAccountId: party.merchant?.id ?? null,
    clientId: request.client?.id ?? null,
    provider: runtime.provider.id,
    flow: party.routing.flow,
    collection: request.collection,
    ui: request.collection === 'checkout' ? request.ui : null,
    capture: request.capture,
    providerChargeId: `${PENDING_PROVIDER_ID}${chargeId}`,
    providerPaymentId: null,
    requestId: request.requestId,
    status: 'open',
    amount,
    customAmount: request.customAmount !== null,
    amountTotal: null,
    amountDiscount: 0,
    amountTax: 0,
    currency: request.currency,
    platformFeeAmount: request.platformFeeAmount,
    amountRefunded: 0,
    amountCapturable: 0,
    captureBefore: null,
    description: request.description,
    items: request.items,
    url: null,
    clientSecret: null,
    expiresAt,
    paidAt: null,
    clientEmail: request.client?.email ?? request.clientEmail,
    paymentMethodId: request.paymentMethod?.id ?? null,
    saveMethod: request.saveMethod,
    failureCode: null,
    transferGroup: party.routing.transferGroup,
    linkId: null,
    billingCustomerId: party.billingCustomerId,
    createdBy: request.createdBy,
    metadata: request.metadata,
    livemode: await runtime.provider.resolveLivemode(),
    syncedAt: null,
  });
}

function providerMetadata(
  runtime: PaymentsRuntime,
  party: ChargeParty,
  row: PaymentChargeRow,
): Record<string, string> {
  return withAppMetadata(
    ownerMetadata(runtime, party.owner, {
      plumbus_charge_id: row.id,
      ...(party.merchant ? { plumbus_merchant_account_id: party.merchant.id } : {}),
    }),
    row.metadata,
  );
}

function checkoutUrls(runtime: PaymentsRuntime, row: PaymentChargeRow) {
  const values = { chargeId: row.id };
  const { urls } = runtime.config;
  return {
    successUrl: urls.checkoutSuccess ? fillUrl(urls.checkoutSuccess, values) : '',
    cancelUrl: urls.checkoutCancel ? fillUrl(urls.checkoutCancel, values) : '',
    returnUrl: urls.checkoutReturn ? fillUrl(urls.checkoutReturn, values) : '',
  };
}

/** Open a hosted or embedded payment page for a saved charge. */
async function openCheckout(
  runtime: PaymentsRuntime,
  party: ChargeParty,
  row: PaymentChargeRow,
  request: Pick<
    ChargeRequest,
    'ui' | 'capture' | 'saveMethod' | 'customAmount' | 'options' | 'client' | 'providerCustomerId'
  >,
  idempotencyKey: string,
  expiresAt: Date,
): Promise<ProviderCharge> {
  return runtime.provider.createCharge({
    ...party.routing,
    reference: row.id,
    currency: row.currency,
    items: row.items ?? [],
    ...(request.customAmount ? { customAmount: request.customAmount } : {}),
    description: row.description,
    platformFeeAmount: row.platformFeeAmount ?? 0,
    ...(request.client
      ? { clientId: request.client.providerClientId }
      : request.providerCustomerId
        ? { clientId: request.providerCustomerId }
        : {}),
    ...(!request.client && !request.providerCustomerId && row.clientEmail
      ? { clientEmail: row.clientEmail }
      : {}),
    ui: request.ui ?? 'hosted',
    ...checkoutUrls(runtime, row),
    expiresAt,
    capture: request.capture,
    saveMethod: request.saveMethod,
    options: request.options,
    metadata: providerMetadata(runtime, party, row),
    idempotencyKey,
  });
}

function unsupported(runtime: PaymentsRuntime, feature: string): PlumbusError {
  return new PlumbusError(
    ErrorCode.Validation,
    `${runtime.provider.displayName} does not support ${feature}`,
    { reason: 'payments_provider_feature_unsupported', feature },
  );
}

/**
 * Send a saved charge to the provider and record the result. Returns the row and
 * whether this call wrote the provider's answer (false when a webhook already
 * applied newer state).
 */
export async function sendCharge(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  party: ChargeParty,
  row: PaymentChargeRow,
  request: ChargeRequest,
  idempotencyKey: string,
): Promise<{ row: PaymentChargeRow; matched: boolean }> {
  const { provider } = runtime;
  // Stamped before the call, so webhook state read after it is never taken for older.
  const startedAt = ctx.time.now();
  let result: ProviderCharge;
  if (request.collection === 'invoice') {
    if (!provider.createInvoiceCharge) throw unsupported(runtime, 'invoices');
    const invoiceCustomer = request.client?.providerClientId ?? request.providerCustomerId;
    if (!invoiceCustomer) {
      throw ctx.errors.validation('Invoices need a client', { reason: 'payments_client_required' });
    }
    result = await provider.createInvoiceCharge({
      ...party.routing,
      reference: row.id,
      currency: row.currency,
      items: row.items ?? [],
      description: row.description,
      platformFeeAmount: row.platformFeeAmount ?? 0,
      clientId: invoiceCustomer,
      dueInDays: request.dueInDays ?? runtime.config.invoices.daysUntilDue,
      automaticTax: request.options.automaticTax ?? false,
      metadata: providerMetadata(runtime, party, row),
      idempotencyKey,
    });
  } else if (request.collection === 'saved_method') {
    if (!provider.chargeSavedMethod) throw unsupported(runtime, 'saved payment methods');
    if (!request.client || !request.paymentMethod) {
      throw ctx.errors.validation('A client with a saved payment method is needed', {
        reason: 'payments_payment_method_required',
      });
    }
    result = await provider.chargeSavedMethod({
      ...party.routing,
      reference: row.id,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      platformFeeAmount: row.platformFeeAmount ?? 0,
      clientId: request.client.providerClientId,
      methodId: request.paymentMethod.providerMethodId,
      capture: request.capture,
      ...(request.options.statementDescriptorSuffix
        ? { statementDescriptorSuffix: request.options.statementDescriptorSuffix }
        : {}),
      metadata: providerMetadata(runtime, party, row),
      idempotencyKey,
    });
  } else {
    result = await openCheckout(
      runtime,
      party,
      row,
      request,
      idempotencyKey,
      row.expiresAt ? new Date(row.expiresAt) : startedAt,
    );
  }

  const outcome = await completeCreation(
    charges(ctx),
    row.id,
    { providerChargeId: row.providerChargeId },
    {
      providerChargeId: result.id,
      providerPaymentId: result.paymentId,
      status: result.status,
      url: result.url,
      clientSecret: result.clientSecret,
      expiresAt: result.expiresAt ?? row.expiresAt ?? null,
      amountTotal: result.amountTotal ?? null,
      amountCapturable: result.amountCapturable ?? 0,
      captureBefore: result.captureBefore,
      failureCode: result.failureCode,
      paidAt: result.status === 'paid' ? (result.paidAt ?? startedAt) : null,
      livemode: result.livemode,
      syncedAt: startedAt,
    },
    {
      url: result.url,
      clientSecret: result.clientSecret,
      expiresAt: result.expiresAt ?? row.expiresAt ?? null,
    },
  );

  // A saved method that needs the client: give them a payment page for the same charge.
  if (
    outcome.matched &&
    outcome.row.status === 'requires_action' &&
    request.collection === 'saved_method'
  ) {
    return {
      row: await openRecoveryPage(ctx, runtime, party, outcome.row, request),
      matched: true,
    };
  }
  return outcome;
}

async function openRecoveryPage(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  party: ChargeParty,
  row: PaymentChargeRow,
  request: ChargeRequest,
): Promise<PaymentChargeRow> {
  const { urls } = runtime.config;
  if (!urls.checkoutSuccess || !urls.checkoutCancel) return row;
  const expiresAt = new Date(
    ctx.time.now().getTime() + runtime.config.checkout.expiresAfterMinutes * 60_000,
  );
  const page = await openCheckout(
    runtime,
    party,
    row,
    { ...request, ui: 'hosted', saveMethod: true },
    `plumbus-recovery:${row.id}`,
    expiresAt,
  );
  return charges(ctx).update(row.id, {
    providerChargeId: page.id,
    url: page.url,
    expiresAt: page.expiresAt ?? expiresAt,
  });
}

/**
 * Fill in provider fields on a row saved before the provider call. If a webhook
 * already applied fresher provider state (the placeholder is gone), keep that
 * state and only add fields webhooks do not carry.
 */
export async function completeCreation<T extends { id: string }>(
  repo: TypedRepo<T>,
  id: string,
  placeholder: Partial<T>,
  fromProvider: Partial<T>,
  onlyIfMissing: Partial<T>,
): Promise<{ row: T; matched: boolean }> {
  if (repo.updateWhere) {
    const result = await repo.updateWhere(id, placeholder, fromProvider);
    if (result.matched && result.row) return { row: result.row, matched: true };
    const current = await repo.findById(id);
    if (!current) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `Row ${id} disappeared while completing creation`,
        { reason: 'payments_row_missing' },
      );
    }
    const missing = Object.fromEntries(
      Object.entries(onlyIfMissing).filter(
        ([name]) => (current as Record<string, unknown>)[name] == null,
      ),
    ) as Partial<T>;
    return {
      row: Object.keys(missing).length > 0 ? await repo.update(id, missing) : current,
      matched: false,
    };
  }
  return { row: await repo.update(id, fromProvider), matched: true };
}

/** Capture all or part of a held charge. */
export async function captureHeld(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  args: {
    charge: PaymentChargeRow;
    merchant: PaymentMerchantAccountRow | null;
    amount: number | undefined;
    platformFeeAmount: number | undefined;
  },
): Promise<PaymentChargeRow> {
  const { charge, merchant } = args;
  const { provider } = runtime;
  if (!provider.captureCharge) throw unsupported(runtime, 'holds (capture)');
  if (charge.status !== 'authorized' || !charge.providerPaymentId) {
    throw ctx.errors.conflict('Only held (authorized) charges can be captured', {
      reason: 'payments_charge_not_authorized',
      status: charge.status,
    });
  }
  const capturable = charge.amountCapturable || charge.amount;
  if (args.amount !== undefined && args.amount > capturable) {
    throw ctx.errors.validation(`At most ${capturable} can be captured`, {
      reason: 'payments_capture_exceeds_hold',
      capturable,
    });
  }
  const startedAt = ctx.time.now();
  const result = await provider.captureCharge({
    routing: chargeRouting(charge, merchant, runtime),
    paymentId: charge.providerPaymentId,
    ...(args.amount !== undefined ? { amount: args.amount } : {}),
    ...(args.platformFeeAmount !== undefined ? { platformFeeAmount: args.platformFeeAmount } : {}),
    idempotencyKey: `plumbus-capture:${charge.id}`,
  });
  return writeProviderStatus(ctx, charge, merchant, result, startedAt);
}

/** Stop a charge: expire its payment page, void its invoice, or release its hold. */
export async function cancelOpen(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  args: { charge: PaymentChargeRow; merchant: PaymentMerchantAccountRow | null },
): Promise<PaymentChargeRow> {
  const { charge, merchant } = args;
  const cancelable: ChargeStatus[] = ['open', 'requires_action', 'authorized'];
  if (!cancelable.includes(charge.status)) {
    throw ctx.errors.conflict(`A ${charge.status} charge cannot be canceled`, {
      reason: 'payments_charge_not_cancelable',
      status: charge.status,
    });
  }
  // Never sent to the provider (a crash mid-creation): nothing to stop there.
  if (isPendingProviderId(charge.providerChargeId)) {
    const updated = await charges(ctx).update(charge.id, { status: 'canceled', url: null });
    await emitChargeStatus(ctx, updated, charge.status, merchant);
    return updated;
  }
  if (!runtime.provider.cancelCharge) throw unsupported(runtime, 'canceling charges');
  const startedAt = ctx.time.now();
  const result = await runtime.provider.cancelCharge({
    routing: chargeRouting(charge, merchant, runtime),
    collection: charge.collection ?? 'checkout',
    chargeId: charge.providerChargeId,
    paymentId: charge.providerPaymentId ?? null,
  });
  return writeProviderStatus(ctx, charge, merchant, result, startedAt);
}

/** Record what the provider answered for an existing charge, emitting its transition once. */
async function writeProviderStatus(
  ctx: ExecutionContext,
  charge: PaymentChargeRow,
  merchant: PaymentMerchantAccountRow | null,
  result: ProviderCharge,
  startedAt: Date,
): Promise<PaymentChargeRow> {
  const repo = charges(ctx);
  const updates: Partial<PaymentChargeRow> = {
    status: result.status,
    ...(result.platformFeeAmount !== null ? { platformFeeAmount: result.platformFeeAmount } : {}),
    ...(result.amountTotal !== null ? { amountTotal: result.amountTotal } : {}),
    amountCapturable: result.amountCapturable ?? 0,
    ...(result.status === 'paid' ? { paidAt: result.paidAt ?? startedAt } : {}),
    ...(result.status !== 'open' && result.status !== 'requires_action' ? { url: null } : {}),
    syncedAt: startedAt,
  };
  let written = true;
  if (repo.updateWhere) {
    written = (await repo.updateWhere(charge.id, { status: charge.status }, updates)).matched;
  } else {
    await repo.update(charge.id, updates);
  }
  const current = (await repo.findById(charge.id)) ?? { ...charge, ...updates };
  // A webhook got there first and already emitted the transition.
  if (written) await emitChargeStatus(ctx, current, charge.status, merchant);
  return current;
}

// ── Refunds ──

export interface RefundArgs {
  charge: PaymentChargeRow;
  merchant: PaymentMerchantAccountRow | null;
  owner: { tenantId: string; ownerType: string; ownerId: string };
  amount: number | undefined;
  reason: CreateRefundInput['reason'] | undefined;
  requestId: string | undefined;
  requestedBy: string | null;
}

export async function refundCharge(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  args: RefundArgs,
): Promise<{ refund: ReturnType<typeof refundView>; created: boolean }> {
  const { charge } = args;
  const repo = refunds(ctx);
  if (args.requestId) {
    const existing = await findOne(repo, {
      tenantId: args.owner.tenantId,
      chargeId: charge.id,
      requestId: args.requestId,
    });
    if (existing) {
      if (
        (args.amount !== undefined && args.amount !== existing.amount) ||
        (args.reason ?? null) !== (existing.reason ?? null)
      ) {
        throw ctx.errors.conflict('requestId was already used for a different refund', {
          reason: 'payments_request_id_reused',
        });
      }
      if (!isPendingProviderId(existing.providerRefundId)) {
        return { refund: refundView(existing), created: false };
      }
      // Saved, but the provider call never finished: send the very same request again.
      return sendRefund(ctx, runtime, args, existing, false);
    }
  }
  if (charge.status !== 'paid' || !charge.providerPaymentId) {
    throw ctx.errors.conflict('Only paid charges can be refunded', {
      reason: 'payments_charge_not_paid',
      status: charge.status,
    });
  }
  // Refunds this app knows of (its own, and ones recorded from webhooks) and the
  // provider's own total can overlap (providers may count pending refunds), so
  // take the larger instead of adding them.
  const known = await settleStaleRefunds(
    ctx,
    runtime,
    args,
    await repo.findMany({ tenantId: args.owner.tenantId, chargeId: charge.id }),
  );
  const committed = known
    .filter(
      (r) => r.status === 'pending' || r.status === 'requires_action' || r.status === 'succeeded',
    )
    .reduce((sum, r) => sum + r.amount, 0);
  const paid = charge.amountTotal ?? charge.amount;
  const refundable = paid - Math.max(committed, charge.amountRefunded ?? 0);
  const amount = args.amount ?? refundable;
  if (amount <= 0 || amount > refundable) {
    throw ctx.errors.validation(`At most ${Math.max(refundable, 0)} can be refunded`, {
      reason: 'payments_refund_exceeds_charge',
      refundable: Math.max(refundable, 0),
    });
  }

  // Saved before the provider call so refund webhooks that race the response find it.
  // With a requestId the id comes from it, so a retry repeats the same provider request.
  const refundId = args.requestId
    ? stableUuid(`plumbus-refund:${charge.id}:${args.requestId}`)
    : randomUUID();
  const row = await repo.create({
    id: refundId,
    tenantId: args.owner.tenantId,
    chargeId: charge.id,
    merchantAccountId: charge.merchantAccountId ?? null,
    provider: runtime.provider.id,
    providerRefundId: `${PENDING_PROVIDER_ID}${refundId}`,
    requestId: args.requestId ?? null,
    amount,
    currency: charge.currency,
    status: 'pending',
    reason: args.reason ?? null,
    failureReason: null,
    requestedBy: args.requestedBy,
    syncedAt: null,
  });
  try {
    return await sendRefund(ctx, runtime, args, row, true);
  } catch (err) {
    await repo.delete(refundId);
    throw err;
  }
}

/**
 * A refund still waiting for its provider id long after the call must have ended
 * lost its outcome (a crash mid-call). If the provider made it, its webhook would
 * normally have filled it in; ask the provider, then keep it or drop it, so a
 * refund that never happened does not hold part of the charge forever.
 */
async function settleStaleRefunds(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  args: RefundArgs,
  rows: PaymentRefundRow[],
): Promise<PaymentRefundRow[]> {
  const { provider } = runtime;
  const paymentId = args.charge.providerPaymentId;
  if (!provider.findRefund || !paymentId) return rows;
  const repo = refunds(ctx);
  const cutoff = ctx.time.now().getTime() - STALE_PENDING_MS;
  const settled: PaymentRefundRow[] = [];
  for (const row of rows) {
    const savedAt = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
    if (!isPendingProviderId(row.providerRefundId) || !(savedAt < cutoff)) {
      settled.push(row);
      continue;
    }
    const startedAt = ctx.time.now();
    const found = await provider.findRefund({
      routing: chargeRouting(args.charge, args.merchant, runtime),
      paymentId,
      reference: row.id,
    });
    if (!found) {
      await repo.delete(row.id);
      continue;
    }
    const { row: completed } = await completeCreation(
      repo,
      row.id,
      { providerRefundId: row.providerRefundId },
      {
        providerRefundId: found.id,
        status: found.status,
        failureReason: found.failureReason,
        syncedAt: startedAt,
      },
      {},
    );
    settled.push(completed);
  }
  return settled;
}

async function sendRefund(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  args: RefundArgs,
  row: PaymentRefundRow,
  created: boolean,
): Promise<{ refund: ReturnType<typeof refundView>; created: boolean }> {
  const { charge, requestId } = args;
  const { config } = runtime;
  const repo = refunds(ctx);
  const routing = chargeRouting(charge, args.merchant, runtime);
  const startedAt = ctx.time.now();
  const providerRefund = await runtime.provider.createRefund({
    routing,
    paymentId: charge.providerPaymentId ?? '',
    reference: row.id,
    amount: row.amount,
    ...(row.reason ? { reason: row.reason as CreateRefundInput['reason'] } : {}),
    refundPlatformFee: config.refunds.refundPlatformFee,
    reverseTransfer: routing.flow === 'destination' && config.refunds.reverseTransfer,
    metadata: ownerMetadata(runtime, args.owner, {
      plumbus_charge_id: charge.id,
      plumbus_refund_id: row.id,
    }),
    idempotencyKey: `plumbus-refund:${requestId ? `${charge.id}:${requestId}` : row.id}`,
  });
  // An earlier attempt reached the provider, and its webhook recorded the refund
  // under a row of its own: keep that one.
  const recorded = await findOne(repo, {
    tenantId: args.owner.tenantId,
    provider: runtime.provider.id,
    providerRefundId: providerRefund.id,
  });
  if (recorded && recorded.id !== row.id) {
    await repo.delete(row.id);
    const kept =
      requestId && !recorded.requestId ? await repo.update(recorded.id, { requestId }) : recorded;
    return { refund: refundView(kept), created: false };
  }
  const { row: completed } = await completeCreation(
    repo,
    row.id,
    { providerRefundId: row.providerRefundId },
    {
      providerRefundId: providerRefund.id,
      status: providerRefund.status,
      failureReason: providerRefund.failureReason,
      syncedAt: startedAt,
    },
    {},
  );
  return { refund: refundView(completed), created };
}
