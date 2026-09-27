// ── Apply provider state to the local copies ──
// Runs inside applyProviderState's transaction. Every change is a fresh read
// from the provider (fetch-on-event), so duplicate or out-of-order webhooks are
// harmless: stale snapshots are skipped by `syncedAt`, statuses never move
// backwards, and refunded amounts never shrink. Events fire only on transitions.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import type { SerializedStateChange } from '../capabilities/schemas.js';
import { PaymentEventName } from '../events/index.js';
import type { ChargeStatus } from '../types/provider.js';
import type {
  MerchantAccountStatus,
  PaymentChargeRow,
  PaymentDisputeRow,
  PaymentMerchantAccountRow,
} from '../types/records.js';
import { charges, disputes, findOne, isUuid, merchantAccounts, refunds } from './repos.js';

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
  if (!syncedAt) return false;
  return new Date(syncedAt).getTime() > scope.observedAt.getTime();
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
  const previousDue = merchant.requirementsDue ?? [];
  const changed =
    status !== merchant.status ||
    account.chargesEnabled !== merchant.chargesEnabled ||
    account.payoutsEnabled !== merchant.payoutsEnabled ||
    previousDue.join('\n') !== account.requirementsDue.join('\n');

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

async function findCharge(
  scope: ApplyScope,
  merchant: PaymentMerchantAccountRow,
  reference: string | null,
  lookup: Partial<PaymentChargeRow>,
): Promise<PaymentChargeRow | null> {
  // References come back from the provider; payments made outside the app may carry anything.
  if (isUuid(reference)) {
    const byId = await charges(scope.ctx).findById(reference);
    if (byId && byId.merchantAccountId === merchant.id) return byId;
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
  const row = merchant
    ? await findCharge(scope, merchant, charge.reference, {
        provider: scope.provider,
        providerChargeId: charge.id,
      })
    : null;
  // Charges the app did not create (e.g. made in the seller's own dashboard) are not ours.
  if (!merchant || !row || isStale(scope, row.syncedAt)) {
    scope.result.skipped += 1;
    return;
  }

  const status = CHARGE_RANK[charge.status] < CHARGE_RANK[row.status] ? row.status : charge.status;
  const amountRefunded = Math.max(row.amountRefunded ?? 0, charge.amountRefunded);
  const paidAt = row.paidAt ?? (charge.paidAt ? new Date(charge.paidAt) : null);

  await charges(scope.ctx).update(row.id, {
    status,
    providerChargeId: charge.id,
    providerPaymentId: charge.paymentId ?? row.providerPaymentId,
    platformFeeAmount: charge.platformFeeAmount,
    amountRefunded,
    paidAt,
    clientEmail: row.clientEmail ?? charge.clientEmail,
    syncedAt: scope.observedAt,
  });
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
        platformFeeAmount: charge.platformFeeAmount,
        clientId: row.clientId ?? null,
        paidAt: (paidAt ?? scope.observedAt).toISOString(),
      });
    } else if (status === 'failed') {
      await emit(scope, PaymentEventName.ChargeFailed, base);
    } else if (status === 'expired') {
      await emit(scope, PaymentEventName.ChargeExpired, base);
    }
  }
  if (amountRefunded > (row.amountRefunded ?? 0)) {
    await emit(scope, PaymentEventName.ChargeRefunded, {
      ...base,
      amountRefunded,
      fullyRefunded: amountRefunded >= row.amount,
    });
  }
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
  let row = await findOne(repo, {
    tenantId: scope.ctx.auth.tenantId,
    provider: scope.provider,
    providerRefundId: refund.id,
  });
  if (!row && isUuid(refund.reference)) {
    const byReference = await repo.findById(refund.reference);
    if (byReference && byReference.chargeId === charge.id) row = byReference;
  }
  if (row && isStale(scope, row.syncedAt)) {
    scope.result.skipped += 1;
    return;
  }

  const previousStatus = row?.status ?? null;
  if (row) {
    await repo.update(row.id, {
      providerRefundId: refund.id,
      status: refund.status,
      failureReason: refund.failureReason,
      syncedAt: scope.observedAt,
    });
  } else {
    // Refunded outside the app (e.g. the seller's dashboard): still record it.
    row = await repo.create({
      id: randomUUID(),
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

  if (refund.status === 'failed' && previousStatus !== 'failed') {
    await emit(scope, PaymentEventName.RefundFailed, {
      ...seller(merchant),
      refundId: row.id,
      chargeId: charge.id,
      amount: refund.amount,
      currency: refund.currency,
      failureReason: refund.failureReason,
    });
  }
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
  const existing = await findOne(repo, {
    tenantId: scope.ctx.auth.tenantId,
    provider: scope.provider,
    providerDisputeId: dispute.id,
  });
  if (existing && isStale(scope, existing.syncedAt)) {
    scope.result.skipped += 1;
    return;
  }

  const fields: Partial<PaymentDisputeRow> = {
    amount: dispute.amount,
    currency: dispute.currency,
    status: dispute.status,
    providerStatus: dispute.providerStatus,
    reason: dispute.reason,
    evidenceDueBy: dispute.evidenceDueBy ? new Date(dispute.evidenceDueBy) : null,
    syncedAt: scope.observedAt,
  };
  let row: PaymentDisputeRow;
  if (existing) {
    row = await repo.update(existing.id, fields);
  } else {
    row = await repo.create({
      ...fields,
      id: randomUUID(),
      tenantId: scope.ctx.auth.tenantId,
      chargeId: charge.id,
      merchantAccountId: merchant.id,
      provider: scope.provider,
      providerDisputeId: dispute.id,
      providerPaymentId: dispute.paymentId,
    });
  }
  scope.result.applied += 1;

  const payload = {
    ...seller(merchant),
    disputeId: row.id,
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
