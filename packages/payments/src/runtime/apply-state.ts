// ── Apply provider state to the local copies ──
// Runs inside applyProviderState's transaction. Every change is a fresh read
// from the provider (fetch-on-event), so duplicate or out-of-order webhooks are
// harmless: stale snapshots are skipped by `syncedAt` and charge statuses never
// move backwards. Events fire only on transitions, and each transition is
// written with a compare-and-set, so workers racing on one row emit it once.
//
// Provider objects are matched to local rows by the local id they carry
// (`reference`) and must also live where the row says: a direct charge on its
// seller's account, everything else on the platform. A seller can therefore not
// claim a platform charge (or another seller's) with a payment of their own.

import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { SerializedStateChange } from '../capabilities/schemas.js';
import { PaymentEventName } from '../events/index.js';
import type { ChargeStatus, SubscriptionStatus } from '../types/provider.js';
import type {
  MerchantAccountStatus,
  PaymentBillingCustomerRow,
  PaymentChargeRow,
  PaymentClientRow,
  PaymentDisputeRow,
  PaymentMerchantAccountRow,
  PaymentRefundRow,
  PaymentSubscriptionRow,
} from '../types/records.js';
import {
  billingCustomers,
  charges,
  clients,
  disputes,
  entitlements,
  findOne,
  invoices,
  isPendingProviderId,
  isUuid,
  links,
  merchantAccounts,
  paymentMethods,
  payouts,
  refunds,
  stableUuid,
  subscriptions,
  type TypedRepo,
  transfers,
  writeIfUnchanged,
} from './repos.js';
import { chargeEventBase, emitChargeCreated, emitChargeStatus } from './charge-engine.js';
import { type PaymentsRuntime, requiredCapabilities } from './runtime.js';

export interface ApplyResult {
  applied: number;
  skipped: number;
  events: number;
}

interface ApplyScope {
  ctx: ExecutionContext;
  runtime: PaymentsRuntime;
  provider: string;
  observedAt: Date;
  result: ApplyResult;
}

type Change<K extends SerializedStateChange['kind']> = Extract<SerializedStateChange, { kind: K }>;

const CHARGE_RANK: Record<ChargeStatus, number> = {
  open: 0,
  requires_action: 1,
  processing: 1,
  authorized: 2,
  paid: 3,
  failed: 3,
  expired: 3,
  canceled: 3,
};

const ACTIVE_SUBSCRIPTION: ReadonlySet<SubscriptionStatus> = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);
const ENDED_SUBSCRIPTION: ReadonlySet<SubscriptionStatus> = new Set([
  'canceled',
  'incomplete_expired',
]);

export function deriveMerchantStatus(
  account: {
    closed: boolean;
    chargesEnabled: boolean;
    transfersEnabled?: boolean;
    requirementsPastDue: string[];
    disabledReason: string | null;
  },
  /** What the seller's charge type needs (default: direct charges, card payments). */
  needs: { cardPayments: boolean; transfers: boolean } = { cardPayments: true, transfers: false },
): MerchantAccountStatus {
  if (account.closed) return 'closed';
  const ready =
    (!needs.cardPayments || account.chargesEnabled) &&
    (!needs.transfers || account.transfersEnabled === true);
  if (ready) return 'active';
  if (account.requirementsPastDue.length > 0 || account.disabledReason) return 'restricted';
  return 'onboarding';
}

/** Whether a fresh account read changes what the app shows (requirement order does not count). */
export function merchantChanged(
  row: PaymentMerchantAccountRow,
  account: {
    chargesEnabled: boolean;
    transfersEnabled?: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
  },
  status: MerchantAccountStatus,
): boolean {
  const before = [...(row.requirementsDue ?? [])].sort();
  const after = [...account.requirementsDue].sort();
  return (
    status !== row.status ||
    account.chargesEnabled !== row.chargesEnabled ||
    (account.transfersEnabled ?? false) !== (row.transfersEnabled ?? false) ||
    account.payoutsEnabled !== row.payoutsEnabled ||
    before.length !== after.length ||
    before.some((item, index) => item !== after[index])
  );
}

/** A row synced after `time` holds newer provider state than a read started at `time`. */
export function syncedAfter(syncedAt: Date | string | null | undefined, time: Date): boolean {
  if (!syncedAt) return false;
  return new Date(syncedAt).getTime() > time.getTime();
}

// Bounded retries when another worker changes the row between read and write.
const MAX_WRITE_ATTEMPTS = 5;

function writeConflict(entity: string): PlumbusError {
  return new PlumbusError(
    ErrorCode.Conflict,
    `${entity} kept changing while provider state was applied`,
    { reason: 'payments_apply_conflict', retryable: true },
  );
}

export async function applyStateChanges(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  observedAt: Date,
  changes: SerializedStateChange[],
): Promise<ApplyResult> {
  const scope: ApplyScope = {
    ctx,
    runtime,
    provider: runtime.provider.id,
    observedAt,
    result: { applied: 0, skipped: 0, events: 0 },
  };
  for (const change of changes) {
    switch (change.kind) {
      case 'merchant':
        await applyMerchant(scope, change);
        break;
      case 'charge':
        await applyCharge(scope, change);
        break;
      case 'refund':
        await applyRefund(scope, change);
        break;
      case 'dispute':
        await applyDispute(scope, change);
        break;
      case 'payment_method':
        await applyPaymentMethod(scope, change);
        break;
      case 'subscription':
        await applySubscription(scope, change);
        break;
      case 'subscription_checkout_expired':
        await applySubscriptionCheckoutExpired(scope, change);
        break;
      case 'invoice':
        await applyInvoice(scope, change);
        break;
      case 'transfer':
        await applyTransfer(scope, change);
        break;
      case 'payout':
        await applyPayout(scope, change);
        break;
      case 'entitlements':
        await applyEntitlements(scope, change);
        break;
    }
  }
  return scope.result;
}

function isStale(scope: ApplyScope, syncedAt: Date | string | null | undefined): boolean {
  return syncedAfter(syncedAt, scope.observedAt);
}

function skip(scope: ApplyScope): void {
  scope.result.skipped += 1;
}

async function emit(scope: ApplyScope, name: string, payload: Record<string, unknown>) {
  await scope.ctx.events.emit(name, payload);
  scope.result.events += 1;
}

const tenant = (scope: ApplyScope) => scope.ctx.auth.tenantId;
const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;
const date = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

async function merchantById(
  scope: ApplyScope,
  id: string | null | undefined,
): Promise<PaymentMerchantAccountRow | null> {
  return id ? merchantAccounts(scope.ctx).findById(id) : null;
}

async function merchantByAccount(
  scope: ApplyScope,
  accountId: string,
): Promise<PaymentMerchantAccountRow | null> {
  return findOne(merchantAccounts(scope.ctx), {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerAccountId: accountId,
  });
}

function sellerFields(merchant: PaymentMerchantAccountRow | null) {
  return {
    merchantAccountId: merchant?.id ?? null,
    ownerType: merchant?.ownerType ?? null,
    ownerId: merchant?.ownerId ?? null,
  };
}

/**
 * Whether an object read from `accountId` (null = the platform) may update a row
 * of this flow: direct rows live on their seller's account, all others on the platform.
 */
function livesWhere(
  flow: string | null | undefined,
  merchant: PaymentMerchantAccountRow | null,
  accountId: string | null,
): boolean {
  if ((flow ?? 'direct') === 'direct') {
    return merchant !== null && accountId === merchant.providerAccountId;
  }
  return accountId === null;
}

/**
 * A row found by reference must also be bound to the same provider object (or
 * still await its provider id). Providers list a charge change before its
 * refunds and disputes, so the payment id is already set when those arrive.
 */
function fitsLookup<T>(row: T, lookup: Partial<T>): boolean {
  return Object.entries(lookup).every(([name, value]) => {
    const actual = (row as Record<string, unknown>)[name];
    return actual === value || isPendingProviderId(actual);
  });
}

async function findByReference<T extends { id: string }>(
  repo: TypedRepo<T>,
  reference: string | null,
  lookup: Partial<T>,
  query: Partial<T>,
): Promise<T | null> {
  // References come back from the provider; objects made outside the app may carry anything.
  if (isUuid(reference)) {
    const byId = await repo.findById(reference);
    if (byId && fitsLookup(byId, lookup)) return byId;
  }
  return findOne(repo, { ...query, ...lookup });
}

// ── Sellers ──

async function applyMerchant(scope: ApplyScope, change: Change<'merchant'>): Promise<void> {
  const { account } = change;
  const merchant = await merchantByAccount(scope, account.id);
  if (!merchant || isStale(scope, merchant.syncedAt)) return skip(scope);
  const status = deriveMerchantStatus(
    account,
    requiredCapabilities(scope.runtime, merchant.chargeType ?? 'direct'),
  );
  const changed = merchantChanged(merchant, account, status);

  await merchantAccounts(scope.ctx).update(merchant.id, {
    status,
    chargesEnabled: account.chargesEnabled,
    transfersEnabled: account.transfersEnabled,
    payoutsEnabled: account.payoutsEnabled,
    requirementsDue: account.requirementsDue,
    requirementsPastDue: account.requirementsPastDue,
    disabledReason: account.disabledReason,
    feesCollector: account.feesCollector,
    lossesCollector: account.lossesCollector,
    country: account.country ?? merchant.country,
    defaultCurrency: account.defaultCurrency ?? merchant.defaultCurrency,
    syncedAt: scope.observedAt,
  });
  scope.result.applied += 1;

  if (changed) {
    await emit(scope, PaymentEventName.MerchantUpdated, {
      merchantAccountId: merchant.id,
      ownerType: merchant.ownerType,
      ownerId: merchant.ownerId,
      status,
      previousStatus: merchant.status,
      chargesEnabled: account.chargesEnabled,
      transfersEnabled: account.transfersEnabled,
      payoutsEnabled: account.payoutsEnabled,
      requirementsDue: account.requirementsDue,
    });
  }
}

// ── Charges ──

async function findCharge(
  scope: ApplyScope,
  reference: string | null,
  lookup: Partial<PaymentChargeRow>,
): Promise<PaymentChargeRow | null> {
  return findByReference(charges(scope.ctx), reference, lookup, { tenantId: tenant(scope) });
}

/** A payment through a reusable link has no row yet: create it from the link. */
async function chargeFromLink(
  scope: ApplyScope,
  change: Change<'charge'>,
): Promise<PaymentChargeRow | null> {
  const { charge } = change;
  if (!charge.linkId) return null;
  const link = await findOne(links(scope.ctx), {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerLinkId: charge.linkId,
  });
  const merchant = link ? await merchantById(scope, link.merchantAccountId) : null;
  if (!link || !livesWhere(link.flow, merchant, change.accountId)) return null;

  // The id comes from the payment page, so workers racing on one payment write one row.
  const row = await charges(scope.ctx).create({
    id: stableUuid(`plumbus-link-charge:${scope.provider}:${charge.id}`),
    tenantId: tenant(scope),
    merchantAccountId: link.merchantAccountId,
    clientId: null,
    provider: scope.provider,
    flow: link.flow,
    collection: 'link',
    ui: 'hosted',
    capture: 'automatic',
    providerChargeId: charge.id,
    providerPaymentId: charge.paymentId,
    requestId: null,
    status: 'open',
    amount: charge.amountSubtotal ?? 0,
    customAmount: link.customAmount ?? false,
    amountTotal: null,
    amountDiscount: 0,
    amountTax: 0,
    currency: charge.currency || link.currency,
    platformFeeAmount: link.platformFeeAmount ?? 0,
    amountRefunded: 0,
    amountCapturable: 0,
    captureBefore: null,
    description: link.description,
    items: link.items.map(({ adjustableQuantity: _adjustable, ...item }) => item),
    url: null,
    clientSecret: null,
    expiresAt: null,
    paidAt: null,
    clientEmail: charge.clientEmail,
    paymentMethodId: null,
    saveMethod: false,
    failureCode: null,
    transferGroup: null,
    linkId: link.id,
    billingCustomerId: null,
    createdBy: null,
    metadata: link.metadata ?? null,
    livemode: charge.livemode,
    syncedAt: null,
  });
  await emitChargeCreated(scope.ctx, row, merchant);
  scope.result.events += 1;
  return row;
}

async function applyCharge(scope: ApplyScope, change: Change<'charge'>): Promise<void> {
  const { charge } = change;
  const repo = charges(scope.ctx);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row =
      (await findCharge(scope, charge.reference, {
        provider: scope.provider,
        providerChargeId: charge.id,
      })) ?? (await chargeFromLink(scope, change));
    const merchant = row ? await merchantById(scope, row.merchantAccountId) : null;
    // Charges the app did not create (e.g. made in the seller's own dashboard) are
    // not ours, and neither is a payment for another amount that reuses our reference.
    if (
      !row ||
      !livesWhere(row.flow, merchant, change.accountId) ||
      isStale(scope, row.syncedAt) ||
      (charge.currency !== '' && row.currency !== charge.currency) ||
      (!row.customAmount && charge.amountSubtotal !== null && row.amount !== charge.amountSubtotal)
    ) {
      return skip(scope);
    }

    const status =
      CHARGE_RANK[charge.status] < CHARGE_RANK[row.status] ? row.status : charge.status;
    const previousRefunded = row.amountRefunded ?? 0;
    // A refund that fails after succeeding gives the money back, so this can go down.
    const amountRefunded = charge.amountRefunded ?? previousRefunded;
    const platformFeeAmount = charge.platformFeeAmount ?? row.platformFeeAmount ?? 0;
    const paidAt =
      row.paidAt ?? (status === 'paid' ? (date(charge.paidAt) ?? scope.observedAt) : null);
    const amount =
      row.customAmount && charge.amountSubtotal !== null ? charge.amountSubtotal : row.amount;
    const methodId = charge.savedMethod
      ? await rememberMethod(scope, row, merchant, change.accountId, charge.savedMethod)
      : null;

    const updates: Partial<PaymentChargeRow> = {
      status,
      amount,
      providerChargeId: charge.id,
      providerPaymentId: charge.paymentId ?? row.providerPaymentId,
      platformFeeAmount,
      amountRefunded,
      amountTotal: charge.amountTotal ?? row.amountTotal ?? null,
      amountDiscount: charge.amountDiscount ?? row.amountDiscount ?? 0,
      amountTax: charge.amountTax ?? row.amountTax ?? 0,
      amountCapturable: charge.amountCapturable ?? row.amountCapturable ?? 0,
      captureBefore: date(charge.captureBefore) ?? row.captureBefore ?? null,
      paidAt,
      clientEmail: row.clientEmail ?? charge.clientEmail,
      failureCode: charge.failureCode ?? (status === 'paid' ? null : (row.failureCode ?? null)),
      ...(methodId ? { paymentMethodId: methodId } : {}),
      syncedAt: scope.observedAt,
    };
    const written = await writeIfUnchanged(
      repo,
      row.id,
      { status: row.status, amountRefunded: row.amountRefunded ?? null },
      updates,
    );
    if (!written) continue;
    scope.result.applied += 1;

    const updated = { ...row, ...updates } as PaymentChargeRow;
    scope.result.events += await emitChargeStatus(scope.ctx, updated, row.status, merchant);
    if (amountRefunded > previousRefunded) {
      await emit(scope, PaymentEventName.ChargeRefunded, {
        ...chargeEventBase(updated, merchant),
        amountRefunded,
        fullyRefunded: amountRefunded >= (updated.amountTotal ?? amount),
      });
    }
    return;
  }
  throw writeConflict('A charge');
}

// ── Refunds and disputes ──

async function findRefund(
  scope: ApplyScope,
  repo: TypedRepo<PaymentRefundRow>,
  chargeId: string,
  refund: Change<'refund'>['refund'],
): Promise<PaymentRefundRow | null> {
  const byProviderId = await findOne(repo, {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerRefundId: refund.id,
  });
  if (byProviderId || !isUuid(refund.reference)) return byProviderId;
  const byReference = await repo.findById(refund.reference);
  return byReference && byReference.chargeId === chargeId ? byReference : null;
}

async function applyRefund(scope: ApplyScope, change: Change<'refund'>): Promise<void> {
  const { refund } = change;
  const charge = await findCharge(scope, change.chargeReference, {
    providerPaymentId: refund.paymentId,
  });
  const merchant = charge ? await merchantById(scope, charge.merchantAccountId) : null;
  if (!charge || !livesWhere(charge.flow, merchant, change.accountId)) return skip(scope);

  const repo = refunds(scope.ctx);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await findRefund(scope, repo, charge.id, refund);
    if (row && isStale(scope, row.syncedAt)) return skip(scope);

    let refundId: string;
    if (row) {
      const written = await writeIfUnchanged(
        repo,
        row.id,
        { status: row.status },
        {
          providerRefundId: refund.id,
          status: refund.status,
          failureReason: refund.failureReason,
          syncedAt: scope.observedAt,
        },
      );
      if (!written) continue;
      refundId = row.id;
    } else {
      // Refunded outside the app (e.g. the seller's dashboard): still record it.
      refundId = stableUuid(`plumbus-refund:${scope.provider}:${refund.id}`);
      await repo.create({
        id: refundId,
        tenantId: tenant(scope),
        chargeId: charge.id,
        merchantAccountId: charge.merchantAccountId ?? null,
        provider: scope.provider,
        providerRefundId: refund.id,
        requestId: null,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        reason: refund.reason,
        failureReason: refund.failureReason,
        requestedBy: null,
        syncedAt: scope.observedAt,
      });
    }
    scope.result.applied += 1;

    if (refund.status === 'failed' && row?.status !== 'failed') {
      await emit(scope, PaymentEventName.RefundFailed, {
        ...sellerFields(merchant),
        refundId,
        chargeId: charge.id,
        amount: refund.amount,
        currency: refund.currency,
        failureReason: refund.failureReason,
      });
    }
    return;
  }
  throw writeConflict('A refund');
}

async function applyDispute(scope: ApplyScope, change: Change<'dispute'>): Promise<void> {
  const { dispute } = change;
  const charge = await findCharge(scope, change.chargeReference, {
    providerPaymentId: dispute.paymentId,
  });
  const merchant = charge ? await merchantById(scope, charge.merchantAccountId) : null;
  // A dispute on a payment the app did not create is not ours to track.
  if (!charge || !livesWhere(charge.flow, merchant, change.accountId)) return skip(scope);

  const repo = disputes(scope.ctx);
  const fields: Partial<PaymentDisputeRow> = {
    amount: dispute.amount,
    currency: dispute.currency,
    status: dispute.status,
    providerStatus: dispute.providerStatus,
    reason: dispute.reason,
    evidenceDueBy: date(dispute.evidenceDueBy),
    evidenceSubmitted: dispute.evidenceSubmitted,
    syncedAt: scope.observedAt,
  };
  let existing: PaymentDisputeRow | null = null;
  let disputeId: string | null = null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && !disputeId; attempt += 1) {
    existing = await findOne(repo, {
      tenantId: tenant(scope),
      provider: scope.provider,
      providerDisputeId: dispute.id,
    });
    if (existing && isStale(scope, existing.syncedAt)) return skip(scope);
    if (!existing) {
      disputeId = stableUuid(`plumbus-dispute:${scope.provider}:${dispute.id}`);
      await repo.create({
        ...fields,
        id: disputeId,
        tenantId: tenant(scope),
        chargeId: charge.id,
        merchantAccountId: charge.merchantAccountId ?? null,
        provider: scope.provider,
        providerDisputeId: dispute.id,
        providerPaymentId: dispute.paymentId,
      });
    } else if (await writeIfUnchanged(repo, existing.id, { status: existing.status }, fields)) {
      disputeId = existing.id;
    }
  }
  if (!disputeId) throw writeConflict('A dispute');
  scope.result.applied += 1;

  const payload = {
    ...sellerFields(merchant),
    disputeId,
    chargeId: charge.id,
    amount: dispute.amount,
    currency: dispute.currency,
    status: dispute.status,
    reason: dispute.reason,
    evidenceDueBy: dispute.evidenceDueBy,
  };
  const closed = ['won', 'lost', 'closed'].includes(dispute.status);
  if (!existing) {
    await emit(scope, PaymentEventName.DisputeOpened, payload);
    if (closed) await emit(scope, PaymentEventName.DisputeClosed, payload);
  } else if (existing.status !== dispute.status) {
    await emit(
      scope,
      closed ? PaymentEventName.DisputeClosed : PaymentEventName.DisputeUpdated,
      payload,
    );
  }
}

// ── Saved payment methods ──

/** Record a payment method saved on a client; returns its local id. */
async function rememberMethod(
  scope: ApplyScope,
  charge: Pick<PaymentChargeRow, 'clientId' | 'merchantAccountId'>,
  merchant: PaymentMerchantAccountRow | null,
  accountId: string | null,
  method: NonNullable<Change<'charge'>['charge']['savedMethod']>,
): Promise<string | null> {
  const clientId =
    charge.clientId ??
    (method.customerId
      ? (await clientByProviderId(scope, method.customerId, accountId))?.id
      : null);
  if (!clientId) return null;
  return upsertMethod(scope, clientId, charge.merchantAccountId ?? null, merchant, method, false);
}

async function clientByProviderId(
  scope: ApplyScope,
  providerClientId: string,
  accountId: string | null,
) {
  const client = await findOne(clients(scope.ctx), {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerClientId,
  });
  return client && (await clientLivesAt(scope, client, accountId)) ? client : null;
}

/** Customers live where their charges do: on the seller account, or on the platform. */
async function clientLivesAt(
  scope: ApplyScope,
  client: PaymentClientRow,
  accountId: string | null,
): Promise<boolean> {
  if (client.onPlatform) return accountId === null;
  const merchant = await merchantById(scope, client.merchantAccountId);
  return merchant !== null && merchant.providerAccountId === accountId;
}

async function upsertMethod(
  scope: ApplyScope,
  clientId: string,
  merchantAccountId: string | null,
  merchant: PaymentMerchantAccountRow | null,
  method: Change<'payment_method'>['method'],
  detached: boolean,
): Promise<string> {
  const repo = paymentMethods(scope.ctx);
  const existing = await findOne(repo, {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerMethodId: method.id,
  });
  const fields = {
    type: method.type,
    brand: method.brand,
    last4: method.last4,
    expMonth: method.expMonth,
    expYear: method.expYear,
    status: detached ? ('removed' as const) : ('active' as const),
  };
  if (existing) {
    await repo.update(existing.id, fields);
    return existing.id;
  }
  const id = stableUuid(`plumbus-method:${scope.provider}:${method.id}`);
  await repo.create({
    id,
    tenantId: tenant(scope),
    clientId,
    merchantAccountId,
    provider: scope.provider,
    providerMethodId: method.id,
    ...fields,
  });
  if (!detached) {
    await emit(scope, PaymentEventName.PaymentMethodSaved, {
      ...sellerFields(merchant),
      clientId,
      paymentMethodId: id,
      type: method.type,
      brand: method.brand,
      last4: method.last4,
    });
  }
  return id;
}

async function applyPaymentMethod(
  scope: ApplyScope,
  change: Change<'payment_method'>,
): Promise<void> {
  const client = change.method.customerId
    ? await clientByProviderId(scope, change.method.customerId, change.accountId)
    : await clientOfKnownMethod(scope, change);
  if (!client) return skip(scope);
  const merchant = await merchantById(scope, client.merchantAccountId);
  await upsertMethod(
    scope,
    client.id,
    client.merchantAccountId ?? null,
    merchant,
    change.method,
    change.detached,
  );
  scope.result.applied += 1;
}

/**
 * A detached method no longer names its customer (Stripe clears it); find the
 * client through the method row saved earlier.
 */
async function clientOfKnownMethod(
  scope: ApplyScope,
  change: Change<'payment_method'>,
): Promise<PaymentClientRow | null> {
  if (!change.detached) return null;
  const method = await findOne(paymentMethods(scope.ctx), {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerMethodId: change.method.id,
  });
  const client = method ? await clients(scope.ctx).findById(method.clientId) : null;
  return client && (await clientLivesAt(scope, client, change.accountId)) ? client : null;
}

// ── Subscriptions and their invoices ──

/** `plumbus:<namespace>:<plan>:<price>` → plan and price keys. */
export function planFromLookupKey(
  lookupKey: string | null,
): { plan: string; price: string } | null {
  const parts = lookupKey?.split(':') ?? [];
  if (parts.length !== 4 || parts[0] !== 'plumbus' || parts[2] === 'meter') return null;
  return { plan: parts[2] as string, price: parts[3] as string };
}

async function billingCustomerOf(
  scope: ApplyScope,
  id: string | null | undefined,
): Promise<PaymentBillingCustomerRow | null> {
  return id ? billingCustomers(scope.ctx).findById(id) : null;
}

async function subscriptionPayload(
  scope: ApplyScope,
  row: PaymentSubscriptionRow,
  previousStatus: string | null,
) {
  const merchant = await merchantById(scope, row.merchantAccountId);
  const customer = await billingCustomerOf(scope, row.billingCustomerId);
  return {
    ...sellerFields(merchant),
    subscriptionId: row.id,
    payee: row.payee,
    clientId: row.clientId ?? null,
    billingCustomerId: row.billingCustomerId ?? null,
    billingOwnerType: customer?.ownerType ?? null,
    billingOwnerId: customer?.ownerId ?? null,
    plan: row.plan ?? null,
    planPrice: row.planPrice ?? null,
    status: row.status,
    previousStatus,
    quantity: row.quantity ?? 1,
    currentPeriodEnd: iso(row.currentPeriodEnd),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
  };
}

async function emitSubscriptionTransition(
  scope: ApplyScope,
  before: PaymentSubscriptionRow,
  after: PaymentSubscriptionRow,
): Promise<void> {
  const wasLive = ACTIVE_SUBSCRIPTION.has(before.status);
  const wasEnded = ENDED_SUBSCRIPTION.has(before.status);
  const payload = await subscriptionPayload(scope, after, before.status);
  if (ENDED_SUBSCRIPTION.has(after.status)) {
    if (!wasEnded) await emit(scope, PaymentEventName.SubscriptionEnded, payload);
    return;
  }
  if (ACTIVE_SUBSCRIPTION.has(after.status) && !wasLive && !wasEnded) {
    await emit(scope, PaymentEventName.SubscriptionStarted, payload);
    return;
  }
  const changed =
    before.status !== after.status ||
    (before.plan ?? null) !== (after.plan ?? null) ||
    (before.planPrice ?? null) !== (after.planPrice ?? null) ||
    (before.quantity ?? 1) !== (after.quantity ?? 1) ||
    (before.cancelAtPeriodEnd ?? false) !== (after.cancelAtPeriodEnd ?? false);
  if (changed && wasLive) await emit(scope, PaymentEventName.SubscriptionUpdated, payload);
}

/**
 * Write a fresh provider read of a subscription to its row (compare-and-set on
 * status) and emit its transition. Returns false when another writer changed the
 * row first; callers re-read and retry.
 */
export async function recordSubscription(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  subscription: Change<'subscription'>['subscription'],
  observedAt: Date,
): Promise<{ written: boolean; row: PaymentSubscriptionRow; events: number }> {
  const licensed = subscription.items.filter((item) => !item.metered);
  const plan = planFromLookupKey(licensed[0]?.lookupKey ?? null);
  const updates: Partial<PaymentSubscriptionRow> = {
    providerSubscriptionId: subscription.id,
    status: subscription.status,
    currency: subscription.currency,
    items: subscription.items.map(({ id: _id, currency: _currency, ...item }) => item),
    quantity: licensed[0]?.quantity ?? 1,
    currentPeriodEnd: date(subscription.currentPeriodEnd),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: date(subscription.canceledAt),
    endedAt: date(subscription.endedAt),
    trialEnd: date(subscription.trialEnd),
    latestInvoiceId: subscription.latestInvoiceId,
    applicationFeePercent: subscription.applicationFeePercent,
    ...(plan ? { plan: plan.plan, planPrice: plan.price } : {}),
    ...(subscription.status !== 'incomplete' ? { checkoutUrl: null } : {}),
    syncedAt: observedAt,
  };
  const repo = subscriptions(ctx);
  if (!(await writeIfUnchanged(repo, row.id, { status: row.status }, updates))) {
    return { written: false, row, events: 0 };
  }
  const after = { ...row, ...updates } as PaymentSubscriptionRow;
  const scope: ApplyScope = {
    ctx,
    runtime,
    provider: runtime.provider.id,
    observedAt,
    result: { applied: 0, skipped: 0, events: 0 },
  };
  await emitSubscriptionTransition(scope, row, after);
  return { written: true, row: after, events: scope.result.events };
}

async function applySubscription(scope: ApplyScope, change: Change<'subscription'>): Promise<void> {
  const { subscription } = change;
  const repo = subscriptions(scope.ctx);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await findByReference(
      repo,
      subscription.reference,
      { provider: scope.provider, providerSubscriptionId: subscription.id },
      { tenantId: tenant(scope) },
    );
    const merchant = row ? await merchantById(scope, row.merchantAccountId) : null;
    if (!row || !livesWhere(row.flow, merchant, change.accountId) || isStale(scope, row.syncedAt)) {
      return skip(scope);
    }
    const outcome = await recordSubscription(
      scope.ctx,
      scope.runtime,
      row,
      subscription,
      scope.observedAt,
    );
    if (!outcome.written) continue;
    scope.result.applied += 1;
    scope.result.events += outcome.events;
    return;
  }
  throw writeConflict('A subscription');
}

/** End a subscription whose checkout expired (or was withdrawn) before the first payment. */
export async function expireSubscriptionCheckout(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  observedAt: Date,
): Promise<{ written: boolean; row: PaymentSubscriptionRow; events: number }> {
  if (row.status !== 'incomplete') return { written: false, row, events: 0 };
  const updates = { status: 'incomplete_expired' as const, checkoutUrl: null, endedAt: observedAt };
  if (!(await writeIfUnchanged(subscriptions(ctx), row.id, { status: row.status }, updates))) {
    return { written: false, row, events: 0 };
  }
  const after = { ...row, ...updates };
  const scope: ApplyScope = {
    ctx,
    runtime,
    provider: runtime.provider.id,
    observedAt,
    result: { applied: 0, skipped: 0, events: 0 },
  };
  await emitSubscriptionTransition(scope, row, after);
  return { written: true, row: after, events: scope.result.events };
}

async function applySubscriptionCheckoutExpired(
  scope: ApplyScope,
  change: Change<'subscription_checkout_expired'>,
): Promise<void> {
  const row = await findByReference(
    subscriptions(scope.ctx),
    change.reference,
    { provider: scope.provider, providerCheckoutId: change.checkoutId },
    { tenantId: tenant(scope) },
  );
  const merchant = row ? await merchantById(scope, row.merchantAccountId) : null;
  if (!row || !livesWhere(row.flow, merchant, change.accountId)) return skip(scope);
  const outcome = await expireSubscriptionCheckout(scope.ctx, scope.runtime, row, scope.observedAt);
  if (!outcome.written) return skip(scope);
  scope.result.applied += 1;
  scope.result.events += outcome.events;
}

async function applyInvoice(scope: ApplyScope, change: Change<'invoice'>): Promise<void> {
  const { invoice } = change;
  const subscription = invoice.subscriptionId
    ? await findOne(subscriptions(scope.ctx), {
        tenantId: tenant(scope),
        provider: scope.provider,
        providerSubscriptionId: invoice.subscriptionId,
      })
    : null;
  const merchant = subscription ? await merchantById(scope, subscription.merchantAccountId) : null;
  if (!subscription || !livesWhere(subscription.flow, merchant, change.accountId)) {
    return skip(scope);
  }

  const repo = invoices(scope.ctx);
  const existing = await findOne(repo, {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerInvoiceId: invoice.id,
  });
  if (existing && isStale(scope, existing.syncedAt)) return skip(scope);
  const fields = {
    status: invoice.status,
    currency: invoice.currency,
    amountDue: invoice.amountDue,
    amountPaid: invoice.amountPaid,
    amountRemaining: invoice.amountRemaining,
    hostedUrl: invoice.hostedUrl,
    pdfUrl: invoice.pdfUrl,
    number: invoice.number,
    dueDate: date(invoice.dueDate),
    periodStart: date(invoice.periodStart),
    periodEnd: date(invoice.periodEnd),
    billingReason: invoice.billingReason,
    attemptCount: invoice.attemptCount,
    syncedAt: scope.observedAt,
  };
  let invoiceId: string;
  if (existing) {
    const basis = { status: existing.status, attemptCount: existing.attemptCount ?? 0 };
    if (!(await writeIfUnchanged(repo, existing.id, basis, fields))) {
      throw writeConflict('An invoice');
    }
    invoiceId = existing.id;
  } else {
    invoiceId = stableUuid(`plumbus-invoice:${scope.provider}:${invoice.id}`);
    await repo.create({
      ...fields,
      id: invoiceId,
      tenantId: tenant(scope),
      subscriptionId: subscription.id,
      merchantAccountId: subscription.merchantAccountId ?? null,
      billingCustomerId: subscription.billingCustomerId ?? null,
      provider: scope.provider,
      providerInvoiceId: invoice.id,
      livemode: invoice.livemode,
    });
  }
  scope.result.applied += 1;

  const payload = {
    ...sellerFields(merchant),
    invoiceId,
    subscriptionId: subscription.id,
    billingCustomerId: subscription.billingCustomerId ?? null,
    amountDue: invoice.amountDue,
    amountPaid: invoice.amountPaid,
    currency: invoice.currency,
    hostedUrl: invoice.hostedUrl,
    billingReason: invoice.billingReason,
  };
  if (invoice.status === 'paid' && existing?.status !== 'paid') {
    await emit(scope, PaymentEventName.InvoicePaid, payload);
  } else if (
    invoice.status === 'open' &&
    invoice.attemptCount > (existing?.attemptCount ?? 0) &&
    invoice.amountPaid < invoice.amountDue
  ) {
    await emit(scope, PaymentEventName.InvoicePaymentFailed, payload);
  }
}

// ── Transfers and payouts ──

async function applyTransfer(scope: ApplyScope, change: Change<'transfer'>): Promise<void> {
  const { transfer } = change;
  const repo = transfers(scope.ctx);
  const row = await findByReference(
    repo,
    transfer.reference,
    { provider: scope.provider, providerTransferId: transfer.id },
    { tenantId: tenant(scope) },
  );
  const merchant = row ? await merchantById(scope, row.merchantAccountId) : null;
  // Transfers made outside the app are not ours, nor one sent to another seller.
  if (!row || !merchant || merchant.providerAccountId !== transfer.destinationAccountId) {
    return skip(scope);
  }
  if (isStale(scope, row.syncedAt)) return skip(scope);
  const previous = row.amountReversed ?? 0;
  const written = await writeIfUnchanged(
    repo,
    row.id,
    { amountReversed: row.amountReversed ?? null },
    {
      providerTransferId: transfer.id,
      amountReversed: transfer.amountReversed,
      syncedAt: scope.observedAt,
    },
  );
  if (!written) throw writeConflict('A transfer');
  scope.result.applied += 1;
  if (transfer.amountReversed > previous) {
    await emit(scope, PaymentEventName.TransferReversed, {
      merchantAccountId: merchant.id,
      ownerType: merchant.ownerType,
      ownerId: merchant.ownerId,
      transferId: row.id,
      chargeId: row.chargeId ?? null,
      amount: row.amount,
      amountReversed: transfer.amountReversed,
      currency: row.currency,
      transferGroup: row.transferGroup ?? null,
    });
  }
}

async function applyPayout(scope: ApplyScope, change: Change<'payout'>): Promise<void> {
  const { payout } = change;
  const merchant = await merchantByAccount(scope, change.accountId);
  if (!merchant) return skip(scope);
  const repo = payouts(scope.ctx);
  const existing = await findOne(repo, {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerPayoutId: payout.id,
  });
  if (existing && isStale(scope, existing.syncedAt)) return skip(scope);
  const fields = {
    amount: payout.amount,
    currency: payout.currency,
    status: payout.status,
    method: payout.method,
    arrivalDate: date(payout.arrivalDate),
    failureCode: payout.failureCode,
    syncedAt: scope.observedAt,
  };
  let payoutId: string;
  if (existing) {
    if (!(await writeIfUnchanged(repo, existing.id, { status: existing.status }, fields))) {
      throw writeConflict('A payout');
    }
    payoutId = existing.id;
  } else {
    payoutId = stableUuid(`plumbus-payout:${scope.provider}:${payout.id}`);
    await repo.create({
      ...fields,
      id: payoutId,
      tenantId: tenant(scope),
      merchantAccountId: merchant.id,
      provider: scope.provider,
      providerPayoutId: payout.id,
      livemode: payout.livemode,
    });
  }
  scope.result.applied += 1;
  if (payout.status === existing?.status) return;
  const payload = {
    merchantAccountId: merchant.id,
    ownerType: merchant.ownerType,
    ownerId: merchant.ownerId,
    payoutId,
    amount: payout.amount,
    currency: payout.currency,
    method: payout.method,
    arrivalDate: payout.arrivalDate,
    failureCode: payout.failureCode,
  };
  if (payout.status === 'paid') await emit(scope, PaymentEventName.PayoutPaid, payload);
  if (payout.status === 'failed') await emit(scope, PaymentEventName.PayoutFailed, payload);
}

// ── Entitlements ──

async function applyEntitlements(scope: ApplyScope, change: Change<'entitlements'>): Promise<void> {
  const customer = await findOne(billingCustomers(scope.ctx), {
    tenantId: tenant(scope),
    provider: scope.provider,
    providerCustomerId: change.customerId,
  });
  if (!customer) return skip(scope);
  const repo = entitlements(scope.ctx);
  const current = await repo.findMany(
    { tenantId: tenant(scope), billingCustomerId: customer.id },
    { limit: 1000 },
  );
  const wanted = new Set(change.features);
  const have = new Set(current.map((row) => row.feature));
  const added = [...wanted].filter((feature) => !have.has(feature)).sort();
  const removed = current.filter((row) => !wanted.has(row.feature));
  for (const feature of added) {
    await repo.create({
      id: stableUuid(`plumbus-entitlement:${customer.id}:${feature}`),
      tenantId: tenant(scope),
      billingCustomerId: customer.id,
      provider: scope.provider,
      feature,
      syncedAt: scope.observedAt,
    });
  }
  for (const row of removed) await repo.delete(row.id);
  scope.result.applied += 1;
  if (added.length > 0 || removed.length > 0) {
    await emit(scope, PaymentEventName.EntitlementsUpdated, {
      billingCustomerId: customer.id,
      ownerType: customer.ownerType,
      ownerId: customer.ownerId,
      features: [...wanted].sort(),
      added,
      removed: removed.map((row) => row.feature).sort(),
    });
  }
}
