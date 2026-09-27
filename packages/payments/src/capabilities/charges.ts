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
import { charges, clients, findOne, refunds, type TypedRepo } from '../runtime/repos.js';
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
import type {
  PaymentChargeRow,
  PaymentClientRow,
  PaymentMerchantAccountRow,
} from '../types/records.js';
import {
  amountSchema,
  chargeStatusSchema,
  chargeViewSchema,
  currencySchema,
  metadataSchema,
  refundViewSchema,
} from './schemas.js';

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
      if (input.requestId) {
        const existing = await findOne(charges(ctx), {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          requestId: input.requestId,
        });
        if (existing) {
          if (existing.amount !== input.amount || existing.currency !== input.currency) {
            throw ctx.errors.conflict('requestId was already used for a different charge', {
              reason: 'payments_request_id_reused',
            });
          }
          return { charge: chargeView(existing), created: false };
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
      const placeholder = `pending:${chargeId}`;
      const expiresAt = new Date(
        ctx.time.now().getTime() + config.checkout.expiresAfterMinutes * 60_000,
      );
      const livemode = await provider.resolveLivemode();
      const repo = charges(ctx);
      let row: PaymentChargeRow;
      try {
        row = await repo.create({
          id: chargeId,
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          clientId: client?.id ?? null,
          provider: provider.id,
          providerChargeId: placeholder,
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

      const urlValues = { chargeId };
      let providerCharge: Awaited<ReturnType<typeof provider.createCharge>>;
      try {
        providerCharge = await provider.createCharge({
          accountId: merchant.providerAccountId,
          reference: chargeId,
          amount: input.amount,
          currency: input.currency,
          description: input.description,
          platformFeeAmount,
          ...(client ? { clientId: client.providerClientId } : {}),
          ...(!client && input.client?.email ? { clientEmail: input.client.email } : {}),
          successUrl: fillUrl(config.urls.checkoutSuccess, urlValues),
          cancelUrl: fillUrl(config.urls.checkoutCancel, urlValues),
          expiresAt,
          metadata: ownerMetadata(runtime, owner, {
            plumbus_charge_id: chargeId,
            plumbus_merchant_account_id: merchant.id,
          }),
          idempotencyKey: `plumbus-charge:${chargeId}`,
        });
      } catch (err) {
        await repo.delete(chargeId);
        throw err;
      }

      row = await completeCreation(
        repo,
        chargeId,
        { providerChargeId: placeholder },
        {
          providerChargeId: providerCharge.id,
          providerPaymentId: providerCharge.paymentId,
          status: providerCharge.status,
          url: providerCharge.url,
          expiresAt: providerCharge.expiresAt ?? expiresAt,
          livemode: providerCharge.livemode,
          syncedAt: ctx.time.now(),
        },
        { url: providerCharge.url, expiresAt: providerCharge.expiresAt ?? expiresAt },
      );

      await ctx.events.emit(PaymentEventName.ChargeCreated, {
        merchantAccountId: merchant.id,
        ownerType: merchant.ownerType,
        ownerId: merchant.ownerId,
        chargeId,
        amount: input.amount,
        currency: input.currency,
        platformFeeAmount,
        clientId: client?.id ?? null,
        createdBy: ctx.auth.userId ?? null,
      });
      return { charge: chargeView(row), created: true };
    },
  });

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
      if (input.requestId) {
        const existing = await findOne(refunds(ctx), {
          tenantId: owner.tenantId,
          chargeId: charge.id,
          requestId: input.requestId,
        });
        if (existing) return { refund: refundView(existing), created: false };
      }
      if (charge.status !== 'paid' || !charge.providerPaymentId) {
        throw ctx.errors.conflict('Only paid charges can be refunded', {
          reason: 'payments_charge_not_paid',
          status: charge.status,
        });
      }
      const pending = await refunds(ctx).findMany({
        tenantId: owner.tenantId,
        chargeId: charge.id,
      });
      const reserved = pending
        .filter((r) => r.status === 'pending' || r.status === 'requires_action')
        .reduce((sum, r) => sum + r.amount, 0);
      const refundable = charge.amount - (charge.amountRefunded ?? 0) - reserved;
      const amount = input.amount ?? refundable;
      if (amount <= 0 || amount > refundable) {
        throw ctx.errors.validation(`At most ${Math.max(refundable, 0)} can be refunded`, {
          reason: 'payments_refund_exceeds_charge',
          refundable: Math.max(refundable, 0),
        });
      }

      // Saved before the provider call so refund webhooks that race the response find it.
      const refundId = randomUUID();
      const placeholder = `pending:${refundId}`;
      const repo = refunds(ctx);
      let row = await repo.create({
        id: refundId,
        tenantId: owner.tenantId,
        chargeId: charge.id,
        merchantAccountId: merchant.id,
        provider: provider.id,
        providerRefundId: placeholder,
        requestId: input.requestId ?? null,
        amount,
        currency: charge.currency,
        status: 'pending',
        reason: input.reason ?? null,
        failureReason: null,
        requestedBy: ctx.auth.userId ?? null,
        syncedAt: null,
      });
      let providerRefund: Awaited<ReturnType<typeof provider.createRefund>>;
      try {
        providerRefund = await provider.createRefund({
          accountId: merchant.providerAccountId,
          paymentId: charge.providerPaymentId,
          reference: refundId,
          amount,
          ...(input.reason ? { reason: input.reason } : {}),
          refundPlatformFee: config.refunds.refundPlatformFee,
          metadata: ownerMetadata(runtime, owner, {
            plumbus_charge_id: charge.id,
            plumbus_refund_id: refundId,
          }),
          idempotencyKey: `plumbus-refund:${input.requestId ? `${charge.id}:${input.requestId}` : refundId}`,
        });
      } catch (err) {
        await repo.delete(refundId);
        throw err;
      }
      row = await completeCreation(
        repo,
        refundId,
        { providerRefundId: placeholder },
        {
          providerRefundId: providerRefund.id,
          status: providerRefund.status,
          failureReason: providerRefund.failureReason,
          syncedAt: ctx.time.now(),
        },
        {},
      );
      return { refund: refundView(row), created: true };
    },
  });

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

async function ensureClient(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: Owner,
  merchant: PaymentMerchantAccountRow,
  input: { email?: string; name?: string; reference?: string; userId?: string },
): Promise<PaymentClientRow> {
  const repo = clients(ctx);
  const base = { tenantId: owner.tenantId, merchantAccountId: merchant.id };
  const existing =
    (input.reference ? await findOne(repo, { ...base, reference: input.reference }) : null) ??
    (input.userId ? await findOne(repo, { ...base, userId: input.userId }) : null) ??
    (input.email ? await findOne(repo, { ...base, email: input.email }) : null);
  if (existing) return existing;

  const clientId = randomUUID();
  const created = await runtime.provider.createClient({
    accountId: merchant.providerAccountId,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    metadata: ownerMetadata(runtime, owner, { plumbus_client_id: clientId }),
    idempotencyKey: `plumbus-client:${clientId}`,
  });
  return repo.create({
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
}
