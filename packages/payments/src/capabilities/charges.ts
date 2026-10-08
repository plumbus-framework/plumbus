// ── Charge capabilities ──
// A charge is one request for money from one client to the caller's seller
// account: a payment page (hosted or embedded), an invoice, or a charge on a
// payment method the client saved. Amounts and your platform fee are decided
// here on the server, never by the browser.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { PaymentEventName } from '../events/index.js';
import {
  type ChargeParty,
  type ChargeRequest,
  cancelOpen,
  captureHeld,
  checkoutOptions,
  emitChargeCreated,
  emitChargeStatus,
  insertCharge,
  itemsTotal,
  refundCharge as refundChargeEngine,
  sendCharge,
} from '../runtime/charge-engine.js';
import { canonicalJson, type ClientInput, ensureClient, findClient } from '../runtime/clients.js';
import {
  charges,
  clients,
  findOne,
  isPendingProviderId,
  paymentMethods,
  refunds,
} from '../runtime/repos.js';
import {
  canTakePayments,
  chargeView,
  computePlatformFee,
  feeMerchant,
  type Owner,
  type PaymentsRuntime,
  refundView,
  requireOwnMerchant,
  requireUrl,
  sellerRouting,
} from '../runtime/runtime.js';
import type { ChargeItem, CheckoutOptions, CustomAmount } from '../types/provider.js';
import type {
  PaymentChargeRow,
  PaymentClientRow,
  PaymentMerchantAccountRow,
} from '../types/records.js';
import {
  amountSchema,
  chargeStatusSchema,
  chargeViewSchema,
  checkoutOptionsSchema,
  collectionSchema,
  currencySchema,
  customAmountSchema,
  itemInputSchema,
  metadataSchema,
  refundViewSchema,
} from './schemas.js';

export const clientInputSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().min(1).max(200).optional(),
    reference: z.string().min(1).max(200).optional(),
    userId: z.string().min(1).max(200).optional(),
  })
  .refine((value) => value.email || value.reference || value.userId, {
    message: 'Identify the client with email, reference, or userId',
  });

const requestIdSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('Your idempotency key: the same requestId returns the same charge');

/** What a payment is for: one amount with the description, or line items. */
function chargeItems(
  ctx: ExecutionContext,
  input: {
    amount?: number;
    description: string;
    items?: Array<{ name: string; description?: string; unitAmount: number; quantity?: number }>;
    customAmount?: CustomAmount;
  },
): ChargeItem[] {
  const given = [
    input.amount !== undefined,
    input.items !== undefined,
    input.customAmount !== undefined,
  ];
  if (given.filter(Boolean).length !== 1) {
    throw ctx.errors.validation('Give exactly one of amount, items, or customAmount', {
      reason: 'payments_amount_required',
    });
  }
  if (input.customAmount) {
    const { minimum, maximum, preset } = input.customAmount;
    if (minimum && preset && preset < minimum) {
      throw ctx.errors.validation('customAmount.preset is below the minimum', {
        reason: 'payments_custom_amount_invalid',
      });
    }
    if (maximum && preset && preset > maximum) {
      throw ctx.errors.validation('customAmount.preset is above the maximum', {
        reason: 'payments_custom_amount_invalid',
      });
    }
    return [{ name: input.description, unitAmount: preset ?? minimum ?? 0, quantity: 1 }];
  }
  if (input.items) {
    return input.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      unitAmount: item.unitAmount,
      quantity: item.quantity ?? 1,
    }));
  }
  return [{ name: input.description, unitAmount: input.amount ?? 0, quantity: 1 }];
}

export function createChargeCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];

  const viewContext = (merchant: PaymentMerchantAccountRow) => ({
    publishableKey: provider.publishableKey ?? null,
    sellerAccountId: merchant.providerAccountId,
  });

  function partyOf(owner: Owner, merchant: PaymentMerchantAccountRow): ChargeParty {
    return {
      tenantId: owner.tenantId,
      merchant,
      owner,
      routing: sellerRouting(runtime, merchant),
      billingCustomerId: null,
    };
  }

  async function requireReadyMerchant(ctx: ExecutionContext) {
    const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
    if (!canTakePayments(runtime, merchant)) {
      throw ctx.errors.conflict('This payment account cannot take payments yet', {
        reason: 'payments_charges_disabled',
        status: merchant.status,
      });
    }
    return { owner, merchant };
  }

  function requireCurrency(ctx: ExecutionContext, currency: string) {
    if (config.currencies && !config.currencies.includes(currency)) {
      throw ctx.errors.validation(`Charges in ${currency} are not supported`, {
        reason: 'payments_currency_not_allowed',
      });
    }
  }

  /** The same requestId must mean the same charge: what, how, for whom, metadata. */
  async function sameChargeRequest(
    ctx: ExecutionContext,
    existing: PaymentChargeRow,
    wanted: Pick<
      ChargeRequest,
      | 'items'
      | 'currency'
      | 'description'
      | 'collection'
      | 'capture'
      | 'saveMethod'
      | 'customAmount'
    > & { metadata?: Record<string, string>; client?: ClientInput; clientId?: string | null },
    party: ChargeParty,
  ): Promise<boolean> {
    const sameWhat =
      itemsKey(existing.items ?? []) === itemsKey(wanted.items) &&
      existing.currency === wanted.currency &&
      existing.description === wanted.description &&
      (existing.collection ?? 'checkout') === wanted.collection &&
      (existing.capture ?? 'automatic') === wanted.capture &&
      (existing.saveMethod ?? false) === wanted.saveMethod &&
      (existing.customAmount ?? false) === (wanted.customAmount !== null) &&
      canonicalJson(existing.metadata ?? {}) === canonicalJson(wanted.metadata ?? {});
    if (!sameWhat) return false;
    if (wanted.clientId !== undefined) return existing.clientId === wanted.clientId;
    if (!wanted.client) return existing.clientId == null;
    const client = await findClient(ctx, clientScope(party), wanted.client);
    return client !== null && client.id === existing.clientId;
  }

  function clientScope(party: ChargeParty) {
    return {
      tenantId: party.tenantId,
      merchant: party.merchant,
      onPlatform: party.routing.flow !== 'direct',
      owner: party.owner,
    };
  }

  /** Return, or finish, the charge an earlier call with this requestId made. */
  async function existingForRequest(
    ctx: ExecutionContext,
    party: ChargeParty,
    requestId: string,
    wanted: Parameters<typeof sameChargeRequest>[2],
    request: () => Promise<ChargeRequest>,
  ): Promise<{ charge: PaymentChargeRow; created: false } | null> {
    const existing = await findOne(charges(ctx), {
      tenantId: party.tenantId,
      merchantAccountId: party.merchant?.id ?? null,
      requestId,
    });
    if (!existing) return null;
    if (!(await sameChargeRequest(ctx, existing, wanted, party))) {
      throw ctx.errors.conflict('requestId was already used for a different charge', {
        reason: 'payments_request_id_reused',
      });
    }
    if (!isPendingProviderId(existing.providerChargeId))
      return { charge: existing, created: false };
    // Saved, but the provider call never finished (a crash or a lost response): finish
    // it now. A page the first attempt may have opened is never shown to anyone, and
    // its webhooks no longer match this charge.
    const now = ctx.time.now();
    const refreshed =
      existing.collection === 'checkout'
        ? await charges(ctx).update(existing.id, {
            expiresAt: new Date(now.getTime() + config.checkout.expiresAfterMinutes * 60_000),
          })
        : existing;
    const { row, matched } = await sendCharge(
      ctx,
      runtime,
      party,
      refreshed,
      await request(),
      `plumbus-charge:${existing.id}:${randomUUID()}`,
    );
    await emitChargeCreated(ctx, row, party.merchant);
    if (matched) await emitChargeStatus(ctx, row, 'open', party.merchant);
    return { charge: row, created: false };
  }

  /** Save, send, and announce a charge; a rejected provider call leaves no row. */
  async function createAndSend(
    ctx: ExecutionContext,
    party: ChargeParty,
    request: ChargeRequest,
  ): Promise<{ charge: PaymentChargeRow; created: boolean }> {
    let row: PaymentChargeRow;
    try {
      row = await insertCharge(ctx, runtime, party, request);
    } catch (err) {
      // A concurrent call with the same requestId inserted first: return its charge.
      const winner = request.requestId
        ? await findOne(charges(ctx), {
            tenantId: party.tenantId,
            merchantAccountId: party.merchant?.id ?? null,
            requestId: request.requestId,
          })
        : null;
      if (winner) return { charge: winner, created: false };
      throw err;
    }
    let sent: Awaited<ReturnType<typeof sendCharge>>;
    try {
      sent = await sendCharge(ctx, runtime, party, row, request, `plumbus-charge:${row.id}`);
    } catch (err) {
      await charges(ctx).delete(row.id);
      throw err;
    }
    await emitChargeCreated(ctx, sent.row, party.merchant);
    if (sent.matched) await emitChargeStatus(ctx, sent.row, 'open', party.merchant);
    return { charge: sent.row, created: true };
  }

  const createCharge = defineCapability({
    name: 'createCharge',
    kind: 'action',
    domain: 'payments',
    description:
      "Ask one client for money on the caller's seller account: a payment page (hosted or embedded) or an invoice",
    input: z.object({
      amount: amountSchema.optional().describe('One amount (the description names it)'),
      description: z.string().min(1).max(500),
      items: z.array(itemInputSchema).min(1).max(100).optional(),
      customAmount: customAmountSchema.optional(),
      currency: currencySchema,
      client: clientInputSchema.optional(),
      metadata: metadataSchema.optional(),
      requestId: requestIdSchema.optional(),
      collection: z
        .enum(['checkout', 'invoice'])
        .optional()
        .describe('checkout: a payment page (default). invoice: an emailed invoice.'),
      ui: z.enum(['hosted', 'embedded']).optional(),
      capture: z
        .enum(['automatic', 'manual'])
        .optional()
        .describe('manual: hold the amount; capture or cancel it later'),
      saveMethod: z
        .boolean()
        .optional()
        .describe("Keep the client's payment method for later charges without them"),
      options: checkoutOptionsSchema.optional(),
      dueInDays: z.number().int().min(1).max(365).optional(),
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
      includeInput: ['amount', 'currency', 'requestId', 'collection', 'capture'],
      includeOutput: ['created'],
    },
    async handler(ctx, input) {
      const { owner, merchant } = await requireReadyMerchant(ctx);
      requireCurrency(ctx, input.currency);
      const items = chargeItems(ctx, input);
      const collection = input.collection ?? 'checkout';
      const capture = input.capture ?? 'automatic';
      const saveMethod = input.saveMethod ?? false;
      if (collection === 'invoice') {
        if (input.capture === 'manual' || saveMethod || input.customAmount || input.ui) {
          throw ctx.errors.validation('Invoices take no ui, capture, saveMethod, or customAmount', {
            reason: 'payments_invoice_options',
          });
        }
        if (!input.client) {
          throw ctx.errors.validation('Invoices need a client', {
            reason: 'payments_client_required',
          });
        }
      }
      if (saveMethod && !input.client) {
        throw ctx.errors.validation('saveMethod needs a client to save the method on', {
          reason: 'payments_client_required',
        });
      }
      const ui = collection === 'checkout' ? (input.ui ?? config.checkout.ui) : null;
      if (ui === 'hosted') {
        requireUrl(ctx, runtime, 'checkoutSuccess');
        requireUrl(ctx, runtime, 'checkoutCancel');
      } else if (ui === 'embedded') {
        requireUrl(ctx, runtime, 'checkoutReturn');
      }
      const party = partyOf(owner, merchant);
      const customAmount = input.customAmount ?? null;
      const options = checkoutOptions(runtime, input.options);

      const buildRequest = async (client: PaymentClientRow | null): Promise<ChargeRequest> => ({
        collection,
        ui,
        capture,
        saveMethod,
        items,
        customAmount,
        description: input.description,
        currency: input.currency,
        platformFeeAmount: await computePlatformFee(ctx, runtime, {
          amount: customAmount ? (customAmount.minimum ?? 0) : itemsTotal(items),
          currency: input.currency,
          kind: collection,
          flow: party.routing.flow,
          merchant: feeMerchant(merchant),
        }),
        client,
        clientEmail: input.client?.email ?? null,
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? null,
        options,
        dueInDays:
          collection === 'invoice' ? (input.dueInDays ?? config.invoices.daysUntilDue) : null,
        paymentMethod: null,
        createdBy: ctx.auth.userId ?? null,
      });

      if (input.requestId) {
        const done = await existingForRequest(
          ctx,
          party,
          input.requestId,
          {
            items,
            currency: input.currency,
            description: input.description,
            collection,
            capture,
            saveMethod,
            customAmount,
            ...(input.metadata ? { metadata: input.metadata } : {}),
            ...(input.client ? { client: input.client } : {}),
          },
          async () => {
            const existing = await findOne(charges(ctx), {
              tenantId: owner.tenantId,
              merchantAccountId: merchant.id,
              requestId: input.requestId,
            });
            const client = existing?.clientId
              ? await clients(ctx).findById(existing.clientId)
              : null;
            return buildRequest(client);
          },
        );
        if (done) return { charge: chargeView(done.charge, viewContext(merchant)), created: false };
      }

      const client = input.client
        ? await ensureClient(ctx, runtime, clientScope(party), input.client)
        : null;
      const result = await createAndSend(ctx, party, await buildRequest(client));
      return { charge: chargeView(result.charge, viewContext(merchant)), created: result.created };
    },
  });

  const chargeSavedMethod = defineCapability({
    name: 'chargeSavedMethod',
    kind: 'action',
    domain: 'payments',
    description:
      'Charge a payment method a client saved earlier, without them (no-show fees, charging after the service)',
    input: z.object({
      clientId: z.string().uuid(),
      paymentMethodId: z
        .string()
        .uuid()
        .optional()
        .describe("Omit to use the client's most recently saved method"),
      amount: amountSchema.optional(),
      items: z.array(itemInputSchema).min(1).max(100).optional(),
      description: z.string().min(1).max(500),
      currency: currencySchema,
      capture: z.enum(['automatic', 'manual']).optional(),
      statementDescriptorSuffix: checkoutOptionsSchema.shape.statementDescriptorSuffix,
      metadata: metadataSchema.optional(),
      requestId: requestIdSchema.optional(),
    }),
    output: z.object({ charge: chargeViewSchema, created: z.boolean() }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Charge, PaymentEntityName.Method],
      events: [
        PaymentEventName.ChargeCreated,
        PaymentEventName.ChargePaid,
        PaymentEventName.ChargeAuthorized,
        PaymentEventName.ChargeActionRequired,
        PaymentEventName.ChargeFailed,
      ],
      external,
      ai: false,
    },
    audit: {
      event: 'payments.charge.saved_method',
      includeInput: ['clientId', 'amount', 'currency', 'requestId'],
      includeOutput: ['created'],
    },
    async handler(ctx, input) {
      const { owner, merchant } = await requireReadyMerchant(ctx);
      requireCurrency(ctx, input.currency);
      const items = chargeItems(ctx, input);
      const client = await clients(ctx).findById(input.clientId);
      if (!client || client.merchantAccountId !== merchant.id) {
        throw ctx.errors.notFound('Client not found', { reason: 'payments_client_not_found' });
      }
      const method = input.paymentMethodId
        ? await paymentMethods(ctx).findById(input.paymentMethodId)
        : ((
            await paymentMethods(ctx).findMany(
              { tenantId: owner.tenantId, clientId: client.id, status: 'active' },
              { orderBy: 'createdAt', orderDir: 'desc', limit: 1 },
            )
          )[0] ?? null);
      if (!method || method.clientId !== client.id || method.status !== 'active') {
        throw ctx.errors.conflict('The client has no saved payment method to charge', {
          reason: 'payments_payment_method_required',
        });
      }
      const party = partyOf(owner, merchant);
      const capture = input.capture ?? 'automatic';
      const options: CheckoutOptions = input.statementDescriptorSuffix
        ? { statementDescriptorSuffix: input.statementDescriptorSuffix }
        : {};
      const request: ChargeRequest = {
        collection: 'saved_method',
        ui: null,
        capture,
        saveMethod: false,
        items,
        customAmount: null,
        description: input.description,
        currency: input.currency,
        platformFeeAmount: await computePlatformFee(ctx, runtime, {
          amount: itemsTotal(items),
          currency: input.currency,
          kind: 'saved_method',
          flow: party.routing.flow,
          merchant: feeMerchant(merchant),
        }),
        client,
        clientEmail: null,
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? null,
        options,
        dueInDays: null,
        paymentMethod: method,
        createdBy: ctx.auth.userId ?? null,
      };
      if (input.requestId) {
        const done = await existingForRequest(
          ctx,
          party,
          input.requestId,
          {
            items,
            currency: input.currency,
            description: input.description,
            collection: 'saved_method',
            capture,
            saveMethod: false,
            customAmount: null,
            ...(input.metadata ? { metadata: input.metadata } : {}),
            clientId: client.id,
          },
          async () => request,
        );
        if (done) return { charge: chargeView(done.charge, viewContext(merchant)), created: false };
      }
      const result = await createAndSend(ctx, party, request);
      return { charge: chargeView(result.charge, viewContext(merchant)), created: result.created };
    },
  });

  const listCharges = defineCapability({
    name: 'listCharges',
    kind: 'query',
    domain: 'payments',
    description: "List charges on the caller's seller account, newest first",
    input: z.object({
      status: chargeStatusSchema.optional(),
      collection: collectionSchema.optional(),
      clientId: z.string().uuid().optional(),
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
          ...(input.collection ? { collection: input.collection } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { charges: rows.map((row) => chargeView(row, viewContext(merchant))) };
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
      return { charge: chargeView(charge, viewContext(merchant)), refunds: rows.map(refundView) };
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
      return refundChargeEngine(ctx, runtime, {
        charge,
        merchant,
        owner,
        amount: input.amount,
        reason: input.reason,
        requestId: input.requestId,
        requestedBy: ctx.auth.userId ?? null,
      });
    },
  });

  const captureCharge = defineCapability({
    name: 'captureCharge',
    kind: 'action',
    domain: 'payments',
    description: 'Capture all or part of a held (authorized) charge; the rest is released',
    input: z.object({
      chargeId: z.string().uuid(),
      amount: amountSchema.optional().describe('Omit to capture the whole hold'),
    }),
    output: z.object({ charge: chargeViewSchema }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Charge],
      events: [PaymentEventName.ChargePaid],
      external,
      ai: false,
    },
    audit: { event: 'payments.charge.capture', includeInput: ['chargeId', 'amount'] },
    async handler(ctx, input) {
      const { merchant } = await requireOwnMerchant(ctx, runtime);
      const charge = await requireOwnCharge(ctx, merchant, input.chargeId);
      // A partial capture recomputes your fee for what is actually captured.
      const platformFeeAmount =
        input.amount === undefined
          ? undefined
          : await computePlatformFee(ctx, runtime, {
              amount: input.amount,
              currency: charge.currency,
              kind: 'capture',
              flow: charge.flow ?? 'direct',
              merchant: feeMerchant(merchant),
            });
      const row = await captureHeld(ctx, runtime, {
        charge,
        merchant,
        amount: input.amount,
        platformFeeAmount,
      });
      return { charge: chargeView(row, viewContext(merchant)) };
    },
  });

  const cancelCharge = defineCapability({
    name: 'cancelCharge',
    kind: 'action',
    domain: 'payments',
    description: 'Withdraw an unpaid charge (its payment page or invoice) or release a hold',
    input: z.object({ chargeId: z.string().uuid() }),
    output: z.object({ charge: chargeViewSchema }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Charge],
      events: [PaymentEventName.ChargeExpired, PaymentEventName.ChargeCanceled],
      external,
      ai: false,
    },
    audit: { event: 'payments.charge.cancel', includeInput: ['chargeId'] },
    async handler(ctx, input) {
      const { merchant } = await requireOwnMerchant(ctx, runtime);
      const charge = await requireOwnCharge(ctx, merchant, input.chargeId);
      const row = await cancelOpen(ctx, runtime, { charge, merchant });
      return { charge: chargeView(row, viewContext(merchant)) };
    },
  });

  return {
    createCharge,
    chargeSavedMethod,
    listCharges,
    getCharge,
    refundCharge,
    captureCharge,
    cancelCharge,
  };
}

/** Line items compared by value (stored JSON may reorder object keys). */
function itemsKey(items: readonly ChargeItem[]): string {
  return JSON.stringify(
    items.map((item) => [item.name, item.description ?? null, item.unitAmount, item.quantity]),
  );
}

export async function requireOwnCharge(
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
