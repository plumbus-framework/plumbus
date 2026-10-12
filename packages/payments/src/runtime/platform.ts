// ── Platform helpers (server-side) ──
// Money the platform itself moves: charging a client on the platform account
// (a marketplace cart spanning several sellers, a charge before the seller is
// known, the app's own sales) and transferring from the platform balance to
// sellers. These are functions, not capabilities: call them from your own
// capability handlers, which decide amounts and who gets paid. They never become
// HTTP routes, so no browser can set a price or move money.
//
// The calling capability must declare `effects.external: ['payments:<provider>']`
// (spread `payments.effects.platform`) so it does not hold a database
// transaction open during provider calls.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { PaymentEventName } from '../events/index.js';
import type { CaptureMode, CheckoutOptions, CheckoutUi, CustomAmount } from '../types/provider.js';
import type {
  PaymentChargeRow,
  PaymentMerchantAccountRow,
  PaymentTransferRow,
} from '../types/records.js';
import {
  type ChargeParty,
  type ChargeRequest,
  cancelOpen,
  captureHeld,
  checkoutOptions,
  emitChargeCreated,
  emitChargeStatus,
  insertCharge,
  refundCharge,
  sendCharge,
} from './charge-engine.js';
import { type ClientInput, ensureClient } from './clients.js';
import {
  charges,
  findOne,
  merchantAccounts,
  PENDING_PROVIDER_ID,
  refunds,
  stableUuid,
  transfers,
  writeIfUnchanged,
} from './repos.js';
import {
  chargeView,
  ownerMetadata,
  type PaymentsRuntime,
  PLATFORM_ROUTING,
  refundView,
  transferView,
} from './runtime.js';

export interface PlatformChargeInput {
  description: string;
  currency: string;
  amount?: number;
  items?: Array<{ name: string; description?: string; unitAmount: number; quantity?: number }>;
  customAmount?: CustomAmount;
  /** Who pays: a client of the platform. */
  client?: ClientInput;
  /** Group the charge with transfers you make to sellers later. */
  transferGroup?: string;
  collection?: 'checkout' | 'invoice';
  ui?: CheckoutUi;
  capture?: CaptureMode;
  saveMethod?: boolean;
  options?: CheckoutOptions;
  dueInDays?: number;
  metadata?: Record<string, string>;
  requestId?: string;
  /** Internal: bill a billing customer (billing.purchase uses this). */
  billingCustomer?: { id: string; providerCustomerId: string };
}

export interface TransferInput {
  merchantAccountId: string;
  amount: number;
  currency: string;
  /** Pay out of this platform charge: the transfer waits for its funds. */
  chargeId?: string;
  transferGroup?: string;
  description?: string;
  metadata?: Record<string, string>;
  requestId?: string;
}

function tenantOf(ctx: ExecutionContext): string {
  const tenantId = ctx.auth.tenantId;
  if (!tenantId) {
    throw ctx.errors.forbidden('Payments need a tenant context (auth.tenantId)', {
      reason: 'payments_tenant_required',
    });
  }
  return tenantId;
}

const platformOwner = (tenantId: string) => ({
  tenantId,
  ownerType: 'platform',
  ownerId: tenantId,
});

async function requirePlatformCharge(
  ctx: ExecutionContext,
  chargeId: string,
): Promise<PaymentChargeRow> {
  const charge = await charges(ctx).findById(chargeId);
  if (!charge || (charge.flow ?? 'direct') !== 'platform') {
    throw ctx.errors.notFound('Platform charge not found', { reason: 'payments_charge_not_found' });
  }
  return charge;
}

export function createPlatformHelpers(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const viewContext = { publishableKey: provider.publishableKey ?? null, sellerAccountId: null };

  /** Charge a client on the platform account. The platform keeps it or transfers it later. */
  async function createCharge(ctx: ExecutionContext, input: PlatformChargeInput) {
    const tenantId = tenantOf(ctx);
    const given = [input.amount, input.items, input.customAmount].filter((v) => v !== undefined);
    if (given.length !== 1) {
      throw ctx.errors.validation('Give exactly one of amount, items, or customAmount', {
        reason: 'payments_amount_required',
      });
    }
    const items = input.items
      ? input.items.map((item) => ({
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          unitAmount: item.unitAmount,
          quantity: item.quantity ?? 1,
        }))
      : [
          {
            name: input.description,
            unitAmount:
              input.amount ?? input.customAmount?.preset ?? input.customAmount?.minimum ?? 0,
            quantity: 1,
          },
        ];
    const collection = input.collection ?? 'checkout';
    const owner = platformOwner(tenantId);
    const party: ChargeParty = {
      tenantId,
      merchant: null,
      owner,
      routing: { ...PLATFORM_ROUTING, transferGroup: input.transferGroup ?? null },
      billingCustomerId: input.billingCustomer?.id ?? null,
    };
    if (input.requestId) {
      const existing = await findOne(charges(ctx), {
        tenantId,
        merchantAccountId: null,
        requestId: input.requestId,
      });
      if (existing) return { charge: chargeView(existing, viewContext), created: false };
    }
    const client =
      input.client && !input.billingCustomer
        ? await ensureClient(
            ctx,
            runtime,
            { tenantId, merchant: null, onPlatform: true, owner },
            input.client,
          )
        : null;
    const ui = collection === 'checkout' ? (input.ui ?? config.checkout.ui) : null;
    const request: ChargeRequest = {
      collection,
      ui,
      capture: input.capture ?? 'automatic',
      saveMethod: input.saveMethod ?? false,
      items,
      customAmount: input.customAmount ?? null,
      description: input.description,
      currency: input.currency,
      platformFeeAmount: 0,
      client,
      ...(input.billingCustomer
        ? { providerCustomerId: input.billingCustomer.providerCustomerId }
        : {}),
      clientEmail: input.client?.email ?? null,
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? null,
      options: checkoutOptions(runtime, input.options),
      dueInDays:
        collection === 'invoice' ? (input.dueInDays ?? config.invoices.daysUntilDue) : null,
      paymentMethod: null,
      createdBy: ctx.auth.userId ?? null,
    };
    const row = await insertCharge(ctx, runtime, party, request);
    let sent: Awaited<ReturnType<typeof sendCharge>>;
    try {
      sent = await sendCharge(ctx, runtime, party, row, request, `plumbus-charge:${row.id}`);
    } catch (err) {
      await charges(ctx).delete(row.id);
      throw err;
    }
    await emitChargeCreated(ctx, sent.row, null);
    if (sent.matched) await emitChargeStatus(ctx, sent.row, 'open', null);
    return { charge: chargeView(sent.row, viewContext), created: true };
  }

  async function refund(
    ctx: ExecutionContext,
    input: {
      chargeId: string;
      amount?: number;
      reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
      requestId?: string;
    },
  ) {
    const tenantId = tenantOf(ctx);
    const charge = await requirePlatformCharge(ctx, input.chargeId);
    return refundCharge(ctx, runtime, {
      charge,
      merchant: null,
      owner: platformOwner(tenantId),
      amount: input.amount,
      reason: input.reason,
      requestId: input.requestId,
      requestedBy: ctx.auth.userId ?? null,
    });
  }

  async function capture(ctx: ExecutionContext, input: { chargeId: string; amount?: number }) {
    const charge = await requirePlatformCharge(ctx, input.chargeId);
    const row = await captureHeld(ctx, runtime, {
      charge,
      merchant: null,
      amount: input.amount,
      platformFeeAmount: undefined,
    });
    return { charge: chargeView(row, viewContext) };
  }

  async function cancel(ctx: ExecutionContext, input: { chargeId: string }) {
    const charge = await requirePlatformCharge(ctx, input.chargeId);
    return {
      charge: chargeView(await cancelOpen(ctx, runtime, { charge, merchant: null }), viewContext),
    };
  }

  /** Send money from the platform balance to a seller. */
  async function transferToSeller(ctx: ExecutionContext, input: TransferInput) {
    const tenantId = tenantOf(ctx);
    if (!config.transfers.enabled || !provider.createTransfer) {
      throw new PlumbusError(ErrorCode.Validation, 'Set transfers.enabled to transfer to sellers', {
        reason: 'payments_transfers_disabled',
      });
    }
    const merchant = await merchantAccounts(ctx).findById(input.merchantAccountId);
    if (!merchant || merchant.tenantId !== tenantId) {
      throw ctx.errors.notFound('Seller not found', { reason: 'payments_no_merchant_account' });
    }
    if (!merchant.transfersEnabled) {
      throw ctx.errors.conflict('This seller cannot receive transfers yet', {
        reason: 'payments_transfers_not_enabled',
        status: merchant.status,
      });
    }
    // A retry with the same requestId returns the first transfer before any balance check.
    const repo = transfers(ctx);
    if (input.requestId) {
      const existing = await findOne(repo, {
        tenantId,
        merchantAccountId: merchant.id,
        requestId: input.requestId,
      });
      if (existing) return { transfer: transferView(existing), created: false };
    }
    let source: PaymentChargeRow | null = null;
    if (input.chargeId) {
      source = await requirePlatformCharge(ctx, input.chargeId);
      if (source.status !== 'paid' || !source.providerPaymentId) {
        throw ctx.errors.conflict('Transfers from a charge need it paid', {
          reason: 'payments_charge_not_paid',
          status: source.status,
        });
      }
      if (source.currency !== input.currency) {
        throw ctx.errors.validation('A transfer from a charge is in the charge currency', {
          reason: 'payments_currency_mismatch',
        });
      }
      const sent = await transfers(ctx).findMany({ tenantId, chargeId: source.id });
      const already = sent.reduce((sum, t) => sum + t.amount - (t.amountReversed ?? 0), 0);
      const available =
        (source.amountTotal ?? source.amount) - (source.amountRefunded ?? 0) - already;
      if (input.amount > available) {
        throw ctx.errors.validation(
          `At most ${Math.max(available, 0)} of this charge can still be transferred`,
          {
            reason: 'payments_transfer_exceeds_charge',
            available: Math.max(available, 0),
          },
        );
      }
    }

    // With a requestId the id comes from it, so a retry repeats the same provider request.
    const id = input.requestId
      ? stableUuid(`plumbus-transfer:${merchant.id}:${input.requestId}`)
      : randomUUID();
    const transferGroup = input.transferGroup ?? source?.transferGroup ?? null;
    const row = await repo.create({
      id,
      tenantId,
      merchantAccountId: merchant.id,
      chargeId: source?.id ?? null,
      provider: provider.id,
      providerTransferId: `${PENDING_PROVIDER_ID}${id}`,
      requestId: input.requestId ?? null,
      amount: input.amount,
      currency: input.currency,
      amountReversed: 0,
      transferGroup,
      description: input.description ?? null,
      metadata: input.metadata ?? null,
      livemode: await provider.resolveLivemode(),
      syncedAt: null,
    });
    const startedAt = ctx.time.now();
    let created: Awaited<ReturnType<NonNullable<typeof provider.createTransfer>>>;
    try {
      created = await provider.createTransfer({
        destinationAccountId: merchant.providerAccountId,
        amount: input.amount,
        currency: input.currency,
        transferGroup,
        sourcePaymentId: source?.providerPaymentId ?? null,
        reference: id,
        metadata: {
          ...(input.metadata ?? {}),
          ...ownerMetadata(runtime, platformOwner(tenantId), {
            plumbus_transfer_id: id,
            plumbus_merchant_account_id: merchant.id,
          }),
        },
        idempotencyKey: `plumbus-transfer:${id}`,
      });
    } catch (err) {
      await repo.delete(id);
      throw err;
    }
    const updated = await repo.update(row.id, {
      providerTransferId: created.id,
      amountReversed: created.amountReversed,
      syncedAt: startedAt,
    });
    await ctx.events.emit(PaymentEventName.TransferCreated, transferPayload(updated, merchant));
    await ctx.audit.record('payments.transfer.create', {
      transferId: id,
      merchantAccountId: merchant.id,
      amount: input.amount,
      currency: input.currency,
    });
    return { transfer: transferView(updated), created: true };
  }

  /** Take (part of) a transfer back from the seller. */
  async function reverseTransfer(
    ctx: ExecutionContext,
    input: { transferId: string; amount?: number },
  ) {
    if (!provider.reverseTransfer) {
      throw new PlumbusError(
        ErrorCode.Validation,
        `${provider.displayName} cannot reverse transfers`,
        {
          reason: 'payments_provider_feature_unsupported',
        },
      );
    }
    const repo = transfers(ctx);
    const transfer = await repo.findById(input.transferId);
    if (!transfer) {
      throw ctx.errors.notFound('Transfer not found', { reason: 'payments_transfer_not_found' });
    }
    const remaining = transfer.amount - (transfer.amountReversed ?? 0);
    if (input.amount !== undefined && input.amount > remaining) {
      throw ctx.errors.validation(`At most ${remaining} can be reversed`, {
        reason: 'payments_reversal_exceeds_transfer',
        remaining,
      });
    }
    const merchant = await merchantAccounts(ctx).findById(transfer.merchantAccountId);
    const startedAt = ctx.time.now();
    const result = await provider.reverseTransfer({
      transferId: transfer.providerTransferId,
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      metadata: ownerMetadata(runtime, platformOwner(transfer.tenantId ?? tenantOf(ctx)), {
        plumbus_transfer_id: transfer.id,
      }),
      idempotencyKey: `plumbus-transfer-reversal:${transfer.id}:${transfer.amountReversed ?? 0}:${input.amount ?? remaining}`,
    });
    const written = await writeIfUnchanged(
      repo,
      transfer.id,
      { amountReversed: transfer.amountReversed ?? null },
      { amountReversed: result.amountReversed, syncedAt: startedAt },
    );
    const current = (await repo.findById(transfer.id)) ?? transfer;
    if (written && merchant && result.amountReversed > (transfer.amountReversed ?? 0)) {
      await ctx.events.emit(PaymentEventName.TransferReversed, transferPayload(current, merchant));
    }
    return { transfer: transferView(current) };
  }

  return {
    createCharge,
    refundCharge: refund,
    captureCharge: capture,
    cancelCharge: cancel,
    transferToSeller,
    reverseTransfer,
    /** Read a platform charge and its refunds. */
    async getCharge(ctx: ExecutionContext, chargeId: string) {
      const charge = await requirePlatformCharge(ctx, chargeId);
      const list = await refunds(ctx).findMany({
        tenantId: ctx.auth.tenantId,
        chargeId: charge.id,
      });
      return { charge: chargeView(charge, viewContext), refunds: list.map(refundView) };
    },
  };
}

function transferPayload(row: PaymentTransferRow, merchant: PaymentMerchantAccountRow) {
  return {
    merchantAccountId: merchant.id,
    ownerType: merchant.ownerType,
    ownerId: merchant.ownerId,
    transferId: row.id,
    chargeId: row.chargeId ?? null,
    amount: row.amount,
    amountReversed: row.amountReversed ?? 0,
    currency: row.currency,
    transferGroup: row.transferGroup ?? null,
  };
}

export type PlatformHelpers = ReturnType<typeof createPlatformHelpers>;
