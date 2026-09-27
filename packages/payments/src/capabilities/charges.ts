// ── Charge capabilities ──
// A charge is one request for money from one client, paid through a
// provider-hosted page on the seller's own account (direct charge). Amounts
// and your platform fee are decided here on the server, never by the browser.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { defineCapability, ErrorCode, PlumbusError } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { PaymentEventName } from '../events/index.js';
import {
  charges,
  clients,
  findOne,
  isPendingProviderId,
  PENDING_PROVIDER_ID,
  refunds,
  stableUuid,
  type TypedRepo,
} from '../runtime/repos.js';
import {
  chargeView,
  computePlatformFee,
  fillUrl,
  type Owner,
  ownerMetadata,
  type PaymentsRuntime,
  refundView,
  requireOwnMerchant,
} from '../runtime/runtime.js';
import type { CreateRefundInput } from '../types/provider.js';
import type {
  PaymentChargeRow,
  PaymentClientRow,
  PaymentMerchantAccountRow,
  PaymentRefundRow,
} from '../types/records.js';
import {
  amountSchema,
  chargeStatusSchema,
  chargeViewSchema,
  currencySchema,
  metadataSchema,
  refundViewSchema,
} from './schemas.js';

type ClientInput = { email?: string; name?: string; reference?: string; userId?: string };

const clientInputSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().min(1).max(200).optional(),
    reference: z.string().min(1).max(200).optional(),
    userId: z.string().min(1).max(200).optional(),
  })
  .refine((value) => value.email || value.reference || value.userId, {
    message: 'Identify the client with email, reference, or userId',
  });

export function createChargeCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];

  const createCharge = defineCapability({
    name: 'createCharge',
    kind: 'action',
    domain: 'payments',
    description:
      "Create a payment link for one client on the caller's seller account; the client pays on a provider-hosted page",
    input: z.object({
      amount: amountSchema,
      currency: currencySchema,
      description: z.string().min(1).max(500),
      client: clientInputSchema.optional(),
      metadata: metadataSchema.optional(),
      requestId: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Your idempotency key: the same requestId returns the same charge'),
    }),
    output: z.object({ charge: chargeViewSchema, created: z.boolean() }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Charge, PaymentEntityName.Client],
      events: [PaymentEventName.ChargeCreated],
      external,
      ai: false,
    },
    audit: {
      event: 'payments.charge.create',
      includeInput: ['amount', 'currency', 'requestId'],
      includeOutput: ['created'],
    },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      if (!merchant.chargesEnabled) {
        throw ctx.errors.conflict('This payment account cannot take payments yet', {
          reason: 'payments_charges_disabled',
          status: merchant.status,
        });
      }
      if (config.currencies && !config.currencies.includes(input.currency)) {
        throw ctx.errors.validation(`Charges in ${input.currency} are not supported`, {
          reason: 'payments_currency_not_allowed',
        });
      }
      const repo = charges(ctx);
      if (input.requestId) {
        const existing = await findOne(repo, {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          requestId: input.requestId,
        });
        if (existing) {
          if (!(await sameChargeRequest(ctx, owner, merchant, existing, input))) {
            throw ctx.errors.conflict('requestId was already used for a different charge', {
              reason: 'payments_request_id_reused',
            });
          }
          if (!isPendingProviderId(existing.providerChargeId)) {
            return { charge: chargeView(existing), created: false };
          }
          // Saved, but the provider call never finished (a crash or a lost response):
          // finish it now. A session the first attempt may have opened is never
          // shown to anyone, and its webhooks no longer match this charge.
          const client = existing.clientId ? await clients(ctx).findById(existing.clientId) : null;
          const now = ctx.time.now();
          const row = await sendCharge(ctx, owner, merchant, existing, client, {
            expiresAt: expiryFrom(now),
            idempotencyKey: `plumbus-charge:${existing.id}:${now.getTime()}`,
          });
          await emitChargeCreated(ctx, merchant, row);
          return { charge: chargeView(row), created: false };
        }
      }

      const client = input.client
        ? await ensureClient(ctx, runtime, owner, merchant, input.client)
        : null;
      const platformFeeAmount = await computePlatformFee(ctx, runtime, {
        amount: input.amount,
        currency: input.currency,
        merchant: {
          id: merchant.id,
          ownerType: merchant.ownerType,
          ownerId: merchant.ownerId,
          dashboard: merchant.dashboard,
          feesCollector: merchant.feesCollector,
        },
      });

      // Save the charge before calling the provider: its webhooks can arrive before the
      // provider call returns, and they find the row by this id (client_reference_id).
      const chargeId = randomUUID();
      const expiresAt = expiryFrom(ctx.time.now());
      const livemode = await provider.resolveLivemode();
      let row: PaymentChargeRow;
      try {
        row = await repo.create({
          id: chargeId,
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          clientId: client?.id ?? null,
          provider: provider.id,
          providerChargeId: `${PENDING_PROVIDER_ID}${chargeId}`,
          providerPaymentId: null,
          requestId: input.requestId ?? null,
          status: 'open',
          amount: input.amount,
          currency: input.currency,
          platformFeeAmount,
          amountRefunded: 0,
          description: input.description,
          url: null,
          expiresAt,
          paidAt: null,
          clientEmail: client?.email ?? input.client?.email ?? null,
          createdBy: ctx.auth.userId ?? null,
          metadata: input.metadata ?? null,
          livemode,
          syncedAt: null,
        });
      } catch (err) {
        // A concurrent call with the same requestId inserted first: return its charge.
        const winner = input.requestId
          ? await findOne(repo, {
              tenantId: owner.tenantId,
              merchantAccountId: merchant.id,
              requestId: input.requestId,
            })
          : null;
        if (winner) return { charge: chargeView(winner), created: false };
        throw err;
      }

      try {
        row = await sendCharge(ctx, owner, merchant, row, client, {
          expiresAt,
          idempotencyKey: `plumbus-charge:${chargeId}`,
        });
      } catch (err) {
        await repo.delete(chargeId);
        throw err;
      }
      await emitChargeCreated(ctx, merchant, row);
      return { charge: chargeView(row), created: true };
    },
  });

  function expiryFrom(now: Date): Date {
    return new Date(now.getTime() + config.checkout.expiresAfterMinutes * 60_000);
  }

  /** Open the provider's payment page for a saved charge and record the result. */
  async function sendCharge(
    ctx: ExecutionContext,
    owner: Owner,
    merchant: PaymentMerchantAccountRow,
    row: PaymentChargeRow,
    client: PaymentClientRow | null,
    request: { expiresAt: Date; idempotencyKey: string },
  ): Promise<PaymentChargeRow> {
    const urlValues = { chargeId: row.id };
    // Stamped before the call, so webhook state read after it is never taken for older.
    const startedAt = ctx.time.now();
    const providerCharge = await provider.createCharge({
      accountId: merchant.providerAccountId,
      reference: row.id,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      platformFeeAmount: row.platformFeeAmount ?? 0,
      ...(client ? { clientId: client.providerClientId } : {}),
      ...(!client && row.clientEmail ? { clientEmail: row.clientEmail } : {}),
      successUrl: fillUrl(config.urls.checkoutSuccess, urlValues),
      cancelUrl: fillUrl(config.urls.checkoutCancel, urlValues),
      expiresAt: request.expiresAt,
      metadata: ownerMetadata(runtime, owner, {
        plumbus_charge_id: row.id,
        plumbus_merchant_account_id: merchant.id,
      }),
      idempotencyKey: request.idempotencyKey,
    });
    const expiresAt = providerCharge.expiresAt ?? request.expiresAt;
    return completeCreation(
      charges(ctx),
      row.id,
      { providerChargeId: row.providerChargeId },
      {
        providerChargeId: providerCharge.id,
        providerPaymentId: providerCharge.paymentId,
        status: providerCharge.status,
        url: providerCharge.url,
        expiresAt,
        livemode: providerCharge.livemode,
        syncedAt: startedAt,
      },
      { url: providerCharge.url, expiresAt },
    );
  }

  async function emitChargeCreated(
    ctx: ExecutionContext,
    merchant: PaymentMerchantAccountRow,
    row: PaymentChargeRow,
  ): Promise<void> {
    await ctx.events.emit(PaymentEventName.ChargeCreated, {
      merchantAccountId: merchant.id,
      ownerType: merchant.ownerType,
      ownerId: merchant.ownerId,
      chargeId: row.id,
      amount: row.amount,
      currency: row.currency,
      platformFeeAmount: row.platformFeeAmount ?? 0,
      clientId: row.clientId ?? null,
      createdBy: row.createdBy ?? null,
    });
  }

  /** The same requestId must mean the same charge: amount, text, client, metadata. */
  async function sameChargeRequest(
    ctx: ExecutionContext,
    owner: Owner,
    merchant: PaymentMerchantAccountRow,
    existing: PaymentChargeRow,
    input: {
      amount: number;
      currency: string;
      description: string;
      client?: ClientInput;
      metadata?: Record<string, string>;
    },
  ): Promise<boolean> {
    if (
      existing.amount !== input.amount ||
      existing.currency !== input.currency ||
      existing.description !== input.description ||
      canonicalJson(existing.metadata ?? {}) !== canonicalJson(input.metadata ?? {})
    ) {
      return false;
    }
    if (!input.client) return existing.clientId == null;
    const client = await findClient(ctx, owner, merchant, input.client);
    return client !== null && client.id === existing.clientId;
  }

  const listCharges = defineCapability({
    name: 'listCharges',
    kind: 'query',
    domain: 'payments',
    description: "List charges on the caller's seller account, newest first",
    input: z.object({
      status: chargeStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ charges: z.array(chargeViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Charge], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await charges(ctx).findMany(
        {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          ...(input.status ? { status: input.status } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { charges: rows.map(chargeView) };
    },
  });

  const getCharge = defineCapability({
    name: 'getCharge',
    kind: 'query',
    domain: 'payments',
    description: 'Read one charge and its refunds',
    input: z.object({ chargeId: z.string().uuid() }),
    output: z.object({ charge: chargeViewSchema, refunds: z.array(refundViewSchema) }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Charge, PaymentEntityName.Refund],
      events: [],
      external: [],
      ai: false,
    },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const charge = await requireOwnCharge(ctx, merchant, input.chargeId);
      const rows = await refunds(ctx).findMany(
        { tenantId: owner.tenantId, chargeId: charge.id },
        { orderBy: 'createdAt', orderDir: 'asc', limit: 100 },
      );
      return { charge: chargeView(charge), refunds: rows.map(refundView) };
    },
  });

  const refundCharge = defineCapability({
    name: 'refundCharge',
    kind: 'action',
    domain: 'payments',
    description: 'Refund all or part of a paid charge to the client',
    input: z.object({
      chargeId: z.string().uuid(),
      amount: amountSchema.optional().describe('Omit to refund everything not yet refunded'),
      reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
      requestId: z.string().min(1).max(100).optional(),
    }),
    output: z.object({ refund: refundViewSchema, created: z.boolean() }),
    access: config.access.refunds,
    effects: {
      data: [PaymentEntityName.Refund],
      events: [],
      external,
      ai: false,
    },
    audit: {
      event: 'payments.charge.refund',
      includeInput: ['chargeId', 'amount', 'reason', 'requestId'],
      includeOutput: ['created'],
    },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const charge = await requireOwnCharge(ctx, merchant, input.chargeId);
      const repo = refunds(ctx);
      if (input.requestId) {
        const existing = await findOne(repo, {
          tenantId: owner.tenantId,
          chargeId: charge.id,
          requestId: input.requestId,
        });
        if (existing) {
          if (
            (input.amount !== undefined && input.amount !== existing.amount) ||
            (input.reason ?? null) !== (existing.reason ?? null)
          ) {
            throw ctx.errors.conflict('requestId was already used for a different refund', {
              reason: 'payments_request_id_reused',
            });
          }
          if (!isPendingProviderId(existing.providerRefundId)) {
            return { refund: refundView(existing), created: false };
          }
          // Saved, but the provider call never finished: send the very same request again.
          return sendRefund(ctx, owner, merchant, charge, existing, input.requestId, false);
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
      const known = await repo.findMany({ tenantId: owner.tenantId, chargeId: charge.id });
      const committed = known
        .filter(
          (r) =>
            r.status === 'pending' || r.status === 'requires_action' || r.status === 'succeeded',
        )
        .reduce((sum, r) => sum + r.amount, 0);
      const refundable = charge.amount - Math.max(committed, charge.amountRefunded ?? 0);
      const amount = input.amount ?? refundable;
      if (amount <= 0 || amount > refundable) {
        throw ctx.errors.validation(`At most ${Math.max(refundable, 0)} can be refunded`, {
          reason: 'payments_refund_exceeds_charge',
          refundable: Math.max(refundable, 0),
        });
      }

      // Saved before the provider call so refund webhooks that race the response find it.
      // With a requestId the id comes from it, so a retry repeats the same provider request.
      const refundId = input.requestId
        ? stableUuid(`plumbus-refund:${charge.id}:${input.requestId}`)
        : randomUUID();
      const row = await repo.create({
        id: refundId,
        tenantId: owner.tenantId,
        chargeId: charge.id,
        merchantAccountId: merchant.id,
        provider: provider.id,
        providerRefundId: `${PENDING_PROVIDER_ID}${refundId}`,
        requestId: input.requestId ?? null,
        amount,
        currency: charge.currency,
        status: 'pending',
        reason: input.reason ?? null,
        failureReason: null,
        requestedBy: ctx.auth.userId ?? null,
        syncedAt: null,
      });
      try {
        return await sendRefund(ctx, owner, merchant, charge, row, input.requestId, true);
      } catch (err) {
        await repo.delete(refundId);
        throw err;
      }
    },
  });

  async function sendRefund(
    ctx: ExecutionContext,
    owner: Owner,
    merchant: PaymentMerchantAccountRow,
    charge: PaymentChargeRow,
    row: PaymentRefundRow,
    requestId: string | undefined,
    created: boolean,
  ): Promise<{ refund: ReturnType<typeof refundView>; created: boolean }> {
    const repo = refunds(ctx);
    const startedAt = ctx.time.now();
    const providerRefund = await provider.createRefund({
      accountId: merchant.providerAccountId,
      paymentId: charge.providerPaymentId ?? '',
      reference: row.id,
      amount: row.amount,
      ...(row.reason ? { reason: row.reason as CreateRefundInput['reason'] } : {}),
      refundPlatformFee: config.refunds.refundPlatformFee,
      metadata: ownerMetadata(runtime, owner, {
        plumbus_charge_id: charge.id,
        plumbus_refund_id: row.id,
      }),
      idempotencyKey: `plumbus-refund:${requestId ? `${charge.id}:${requestId}` : row.id}`,
    });
    // An earlier attempt reached the provider, and its webhook recorded the refund
    // under a row of its own: keep that one.
    const recorded = await findOne(repo, {
      tenantId: owner.tenantId,
      provider: provider.id,
      providerRefundId: providerRefund.id,
    });
    if (recorded && recorded.id !== row.id) {
      await repo.delete(row.id);
      const kept =
        requestId && !recorded.requestId ? await repo.update(recorded.id, { requestId }) : recorded;
      return { refund: refundView(kept), created: false };
    }
    const completed = await completeCreation(
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

  return { createCharge, listCharges, getCharge, refundCharge };
}

/**
 * Fill in provider fields on a row saved before the provider call. If a webhook
 * already applied fresher provider state (the placeholder is gone), keep that
 * state and only add fields webhooks do not carry.
 */
async function completeCreation<T extends { id: string }>(
  repo: TypedRepo<T>,
  id: string,
  placeholder: Partial<T>,
  fromProvider: Partial<T>,
  onlyIfMissing: Partial<T>,
): Promise<T> {
  if (repo.updateWhere) {
    const result = await repo.updateWhere(id, placeholder, fromProvider);
    if (result.matched && result.row) return result.row;
    const current = await repo.findById(id);
    if (!current) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `Row ${id} disappeared while completing creation`,
        {
          reason: 'payments_row_missing',
        },
      );
    }
    const missing = Object.fromEntries(
      Object.entries(onlyIfMissing).filter(
        ([key]) => (current as Record<string, unknown>)[key] == null,
      ),
    ) as Partial<T>;
    return Object.keys(missing).length > 0 ? repo.update(id, missing) : current;
  }
  return repo.update(id, fromProvider);
}

async function requireOwnCharge(
  ctx: ExecutionContext,
  merchant: PaymentMerchantAccountRow,
  chargeId: string,
): Promise<PaymentChargeRow> {
  const charge = await charges(ctx).findById(chargeId);
  if (!charge || charge.merchantAccountId !== merchant.id) {
    throw ctx.errors.notFound('Charge not found', { reason: 'payments_charge_not_found' });
  }
  return charge;
}

/** JSON with sorted keys, for comparing flat metadata maps. */
function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The client this input names. `reference` wins, then `userId`, then `email`; a
 * client found by a weaker identifier is only reused when it does not carry a
 * different reference or userId (two children can share a parent's email).
 */
async function findClient(
  ctx: ExecutionContext,
  owner: Owner,
  merchant: PaymentMerchantAccountRow,
  input: ClientInput,
): Promise<PaymentClientRow | null> {
  const repo = clients(ctx);
  const base = { tenantId: owner.tenantId, merchantAccountId: merchant.id };
  const fits = (row: PaymentClientRow) =>
    (!input.reference || row.reference == null || row.reference === input.reference) &&
    (!input.userId || row.userId == null || row.userId === input.userId);
  if (input.reference) {
    const row = await findOne(repo, { ...base, reference: input.reference });
    if (row) return row;
  }
  for (const lookup of [
    input.userId ? { userId: input.userId } : null,
    input.email ? { email: input.email } : null,
  ]) {
    if (!lookup) continue;
    const row = (await repo.findMany({ ...base, ...lookup }, { limit: 100 })).find(fits);
    if (row) return row;
  }
  return null;
}

async function ensureClient(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: Owner,
  merchant: PaymentMerchantAccountRow,
  input: ClientInput,
): Promise<PaymentClientRow> {
  const repo = clients(ctx);
  const existing = await findClient(ctx, owner, merchant, input);
  if (existing) {
    // Remember identifiers the client was found without, so later lookups by them work.
    const missing = {
      ...(input.reference && existing.reference == null ? { reference: input.reference } : {}),
      ...(input.userId && existing.userId == null ? { userId: input.userId } : {}),
    };
    return Object.keys(missing).length > 0 ? repo.update(existing.id, missing) : existing;
  }

  // The id comes from the strongest identifier, so concurrent first charges for one
  // client create it once: same row id, same provider idempotency key.
  const identity = input.reference
    ? `reference:${input.reference}`
    : input.userId
      ? `user:${input.userId}`
      : `email:${input.email ?? ''}`;
  const clientId = stableUuid(`plumbus-client:${merchant.id}:${identity}`);
  const created = await runtime.provider.createClient({
    accountId: merchant.providerAccountId,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    metadata: ownerMetadata(runtime, owner, { plumbus_client_id: clientId }),
    idempotencyKey: `plumbus-client:${clientId}`,
  });
  try {
    return await repo.create({
      id: clientId,
      tenantId: owner.tenantId,
      merchantAccountId: merchant.id,
      provider: runtime.provider.id,
      providerClientId: created.clientId,
      reference: input.reference ?? null,
      userId: input.userId ?? null,
      email: input.email ?? null,
      name: input.name ?? null,
    });
  } catch (err) {
    const winner = await repo.findById(clientId);
    if (winner) return winner;
    throw err;
  }
}
