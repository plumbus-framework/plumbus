// ── Apply provider state to the local copies ──
// Runs inside applyProviderState's transaction. Every change is a fresh read
// from the provider (fetch-on-event), so duplicate or out-of-order webhooks are
// harmless: stale snapshots are skipped by `syncedAt` and charge statuses never
// move backwards. Events fire only on transitions, and each transition is
// written with a compare-and-set, so workers racing on one row emit it once.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { SerializedStateChange } from '../capabilities/schemas.js';
import { PaymentEventName } from '../events/index.js';
import type { ChargeStatus } from '../types/provider.js';
import type {
  MerchantAccountStatus,
  PaymentChargeRow,
  PaymentDisputeRow,
  PaymentMerchantAccountRow,
  PaymentRefundRow,
} from '../types/records.js';
import {
  charges,
  disputes,
  findOne,
  isPendingProviderId,
  isUuid,
  merchantAccounts,
  refunds,
  type TypedRepo,
  writeIfUnchanged,
} from './repos.js';

export interface ApplyResult {
  applied: number;
  skipped: number;
  events: number;
}

interface ApplyScope {
  ctx: ExecutionContext;
  provider: string;
  observedAt: Date;
  result: ApplyResult;
}

const CHARGE_RANK: Record<ChargeStatus, number> = {
  open: 0,
  processing: 1,
  paid: 2,
  failed: 2,
  expired: 2,
};

export function deriveMerchantStatus(account: {
  closed: boolean;
  chargesEnabled: boolean;
  requirementsPastDue: string[];
  disabledReason: string | null;
}): MerchantAccountStatus {
  if (account.closed) return 'closed';
  if (account.chargesEnabled) return 'active';
  if (account.requirementsPastDue.length > 0 || account.disabledReason) return 'restricted';
  return 'onboarding';
}

/** Whether a fresh account read changes what the app shows (requirement order does not count). */
export function merchantChanged(
  row: PaymentMerchantAccountRow,
  account: { chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: string[] },
  status: MerchantAccountStatus,
): boolean {
  const before = [...(row.requirementsDue ?? [])].sort();
  const after = [...account.requirementsDue].sort();
  return (
    status !== row.status ||
    account.chargesEnabled !== row.chargesEnabled ||
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
  provider: string,
  observedAt: Date,
  changes: SerializedStateChange[],
): Promise<ApplyResult> {
  const scope: ApplyScope = {
    ctx,
    provider,
    observedAt,
    result: { applied: 0, skipped: 0, events: 0 },
  };
  for (const change of changes) {
    switch (change.kind) {
      case 'merchant':
        await applyMerchant(scope, change.account);
        break;
      case 'charge':
        await applyCharge(scope, change.accountId, change.charge);
        break;
      case 'refund':
        await applyRefund(scope, change.accountId, change.chargeReference, change.refund);
        break;
      case 'dispute':
        await applyDispute(scope, change.accountId, change.chargeReference, change.dispute);
        break;
    }
  }
  return scope.result;
}

function isStale(scope: ApplyScope, syncedAt: Date | string | null | undefined): boolean {
  return syncedAfter(syncedAt, scope.observedAt);
}

async function emit(scope: ApplyScope, name: string, payload: Record<string, unknown>) {
  await scope.ctx.events.emit(name, payload);
  scope.result.events += 1;
}

async function findMerchant(
  scope: ApplyScope,
  accountId: string,
): Promise<PaymentMerchantAccountRow | null> {
  return findOne(merchantAccounts(scope.ctx), {
    tenantId: scope.ctx.auth.tenantId,
    provider: scope.provider,
    providerAccountId: accountId,
  });
}

function seller(merchant: PaymentMerchantAccountRow) {
  return {
    merchantAccountId: merchant.id,
    ownerType: merchant.ownerType,
    ownerId: merchant.ownerId,
  };
}

async function applyMerchant(
  scope: ApplyScope,
  account: Extract<SerializedStateChange, { kind: 'merchant' }>['account'],
): Promise<void> {
  const merchant = await findMerchant(scope, account.id);
  if (!merchant || isStale(scope, merchant.syncedAt)) {
    scope.result.skipped += 1;
    return;
  }
  const status = deriveMerchantStatus(account);
  const changed = merchantChanged(merchant, account, status);

  await merchantAccounts(scope.ctx).update(merchant.id, {
    status,
    chargesEnabled: account.chargesEnabled,
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
      ...seller(merchant),
      status,
      previousStatus: merchant.status,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      requirementsDue: account.requirementsDue,
    });
  }
}

/**
 * A row found by reference must also be bound to the same provider object (or
 * still await its provider id). Providers list a charge change before its
 * refunds and disputes, so the payment id is already set when those arrive.
 */
function fitsLookup<T>(row: T, lookup: Partial<T>): boolean {
  return Object.entries(lookup).every(([key, value]) => {
    const actual = (row as Record<string, unknown>)[key];
    return actual === value || isPendingProviderId(actual);
  });
}

async function findCharge(
  scope: ApplyScope,
  merchant: PaymentMerchantAccountRow,
  reference: string | null,
  lookup: Partial<PaymentChargeRow>,
): Promise<PaymentChargeRow | null> {
  // References come back from the provider; payments made outside the app may carry anything.
  if (isUuid(reference)) {
    const byId = await charges(scope.ctx).findById(reference);
    if (byId && byId.merchantAccountId === merchant.id && fitsLookup(byId, lookup)) return byId;
  }
  return findOne(charges(scope.ctx), {
    tenantId: scope.ctx.auth.tenantId,
    merchantAccountId: merchant.id,
    ...lookup,
  });
}

async function applyCharge(
  scope: ApplyScope,
  accountId: string,
  charge: Extract<SerializedStateChange, { kind: 'charge' }>['charge'],
): Promise<void> {
  const merchant = await findMerchant(scope, accountId);
  if (!merchant) {
    scope.result.skipped += 1;
    return;
  }
  const repo = charges(scope.ctx);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await findCharge(scope, merchant, charge.reference, {
      provider: scope.provider,
      providerChargeId: charge.id,
    });
    // Charges the app did not create (e.g. made in the seller's own dashboard) are
    // not ours, and neither is a payment for another amount that reuses our reference.
    if (
      !row ||
      isStale(scope, row.syncedAt) ||
      row.amount !== charge.amount ||
      row.currency !== charge.currency
    ) {
      scope.result.skipped += 1;
      return;
    }

    const status =
      CHARGE_RANK[charge.status] < CHARGE_RANK[row.status] ? row.status : charge.status;
    const previousRefunded = row.amountRefunded ?? 0;
    // A refund that fails after succeeding gives the money back, so this can go down.
    const amountRefunded = charge.amountRefunded ?? previousRefunded;
    const platformFeeAmount = charge.platformFeeAmount ?? row.platformFeeAmount ?? 0;
    const paidAt = row.paidAt ?? (charge.paidAt ? new Date(charge.paidAt) : null);

    const written = await writeIfUnchanged(
      repo,
      row.id,
      { status: row.status, amountRefunded: row.amountRefunded ?? null },
      {
        status,
        providerChargeId: charge.id,
        providerPaymentId: charge.paymentId ?? row.providerPaymentId,
        platformFeeAmount,
        amountRefunded,
        paidAt,
        clientEmail: row.clientEmail ?? charge.clientEmail,
        syncedAt: scope.observedAt,
      },
    );
    if (!written) continue;
    scope.result.applied += 1;

    const base = {
      ...seller(merchant),
      chargeId: row.id,
      amount: row.amount,
      currency: row.currency,
    };
    if (status !== row.status) {
      if (status === 'paid') {
        await emit(scope, PaymentEventName.ChargePaid, {
          ...base,
          platformFeeAmount,
          clientId: row.clientId ?? null,
          paidAt: (paidAt ?? scope.observedAt).toISOString(),
        });
      } else if (status === 'failed') {
        await emit(scope, PaymentEventName.ChargeFailed, base);
      } else if (status === 'expired') {
        await emit(scope, PaymentEventName.ChargeExpired, base);
      }
    }
    if (amountRefunded > previousRefunded) {
      await emit(scope, PaymentEventName.ChargeRefunded, {
        ...base,
        amountRefunded,
        fullyRefunded: amountRefunded >= row.amount,
      });
    }
    return;
  }
  throw writeConflict('A charge');
}

async function findRefund(
  scope: ApplyScope,
  repo: TypedRepo<PaymentRefundRow>,
  chargeId: string,
  refund: Extract<SerializedStateChange, { kind: 'refund' }>['refund'],
): Promise<PaymentRefundRow | null> {
  const byProviderId = await findOne(repo, {
    tenantId: scope.ctx.auth.tenantId,
    provider: scope.provider,
    providerRefundId: refund.id,
  });
  if (byProviderId || !isUuid(refund.reference)) return byProviderId;
  const byReference = await repo.findById(refund.reference);
  return byReference && byReference.chargeId === chargeId ? byReference : null;
}

async function applyRefund(
  scope: ApplyScope,
  accountId: string,
  chargeReference: string | null,
  refund: Extract<SerializedStateChange, { kind: 'refund' }>['refund'],
): Promise<void> {
  const merchant = await findMerchant(scope, accountId);
  const charge = merchant
    ? await findCharge(scope, merchant, chargeReference, { providerPaymentId: refund.paymentId })
    : null;
  if (!merchant || !charge) {
    scope.result.skipped += 1;
    return;
  }

  const repo = refunds(scope.ctx);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await findRefund(scope, repo, charge.id, refund);
    if (row && isStale(scope, row.syncedAt)) {
      scope.result.skipped += 1;
      return;
    }

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
      refundId = randomUUID();
      await repo.create({
        id: refundId,
        tenantId: scope.ctx.auth.tenantId,
        chargeId: charge.id,
        merchantAccountId: merchant.id,
        provider: scope.provider,
        providerRefundId: refund.id,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        reason: refund.reason,
        failureReason: refund.failureReason,
        syncedAt: scope.observedAt,
      });
    }
    scope.result.applied += 1;

    if (refund.status === 'failed' && row?.status !== 'failed') {
      await emit(scope, PaymentEventName.RefundFailed, {
        ...seller(merchant),
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

async function applyDispute(
  scope: ApplyScope,
  accountId: string,
  chargeReference: string | null,
  dispute: Extract<SerializedStateChange, { kind: 'dispute' }>['dispute'],
): Promise<void> {
  const merchant = await findMerchant(scope, accountId);
  if (!merchant) {
    scope.result.skipped += 1;
    return;
  }
  const charge = await findCharge(scope, merchant, chargeReference, {
    providerPaymentId: dispute.paymentId,
  });
  if (!charge) {
    // A dispute on a payment the app did not create is not ours to track.
    scope.result.skipped += 1;
    return;
  }

  const repo = disputes(scope.ctx);
  const fields: Partial<PaymentDisputeRow> = {
    amount: dispute.amount,
    currency: dispute.currency,
    status: dispute.status,
    providerStatus: dispute.providerStatus,
    reason: dispute.reason,
    evidenceDueBy: dispute.evidenceDueBy ? new Date(dispute.evidenceDueBy) : null,
    syncedAt: scope.observedAt,
  };
  let existing: PaymentDisputeRow | null = null;
  let disputeId: string | null = null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && !disputeId; attempt += 1) {
    existing = await findOne(repo, {
      tenantId: scope.ctx.auth.tenantId,
      provider: scope.provider,
      providerDisputeId: dispute.id,
    });
    if (existing && isStale(scope, existing.syncedAt)) {
      scope.result.skipped += 1;
      return;
    }
    if (!existing) {
      disputeId = randomUUID();
      await repo.create({
        ...fields,
        id: disputeId,
        tenantId: scope.ctx.auth.tenantId,
        chargeId: charge.id,
        merchantAccountId: merchant.id,
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
    ...seller(merchant),
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
