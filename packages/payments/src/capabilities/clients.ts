// ── Client capabilities ──
// A seller's clients, the payment methods they saved for later charges, and
// the provider's self-service portal (update a card, see invoices, manage
// subscriptions). Card numbers never reach the app: only brand and last digits.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { ensureClient } from '../runtime/clients.js';
import { clients, paymentMethods, stableUuid } from '../runtime/repos.js';
import {
  canTakePayments,
  clientView,
  fillUrl,
  ownerMetadata,
  type PaymentsRuntime,
  paymentMethodView,
  requireOwnMerchant,
  requireUrl,
} from '../runtime/runtime.js';
import type { PaymentClientRow, PaymentMerchantAccountRow } from '../types/records.js';
import { clientInputSchema } from './charges.js';
import { clientViewSchema, paymentMethodViewSchema } from './schemas.js';

/** A client's provider customer lives on the seller account only for direct charges. */
const sellerAccountOf = (merchant: PaymentMerchantAccountRow, client: PaymentClientRow) =>
  client.onPlatform ? null : merchant.providerAccountId;

export function createClientCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];

  async function requireOwnClient(
    ctx: ExecutionContext,
    clientId: string,
  ): Promise<{ merchant: PaymentMerchantAccountRow; client: PaymentClientRow }> {
    const { merchant } = await requireOwnMerchant(ctx, runtime);
    const client = await clients(ctx).findById(clientId);
    if (!client || client.merchantAccountId !== merchant.id) {
      throw ctx.errors.notFound('Client not found', { reason: 'payments_client_not_found' });
    }
    return { merchant, client };
  }

  const listClients = defineCapability({
    name: 'listClients',
    kind: 'query',
    domain: 'payments',
    description: "List the caller's clients, newest first",
    input: z.object({
      reference: z.string().min(1).max(200).optional(),
      email: z.string().email().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ clients: z.array(clientViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Client], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await clients(ctx).findMany(
        {
          tenantId: owner.tenantId,
          merchantAccountId: merchant.id,
          ...(input.reference ? { reference: input.reference } : {}),
          ...(input.email ? { email: input.email } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { clients: rows.map(clientView) };
    },
  });

  const createSetupSession = provider.createSetupSession?.bind(provider);
  const saveClientPaymentMethod = createSetupSession
    ? defineCapability({
        name: 'saveClientPaymentMethod',
        kind: 'action',
        domain: 'payments',
        description:
          'Send a client to a provider page that saves a payment method for later charges (no payment now)',
        input: z.object({ client: clientInputSchema }),
        output: z.object({
          clientId: z.string(),
          url: z.string(),
          expiresAt: z.string().nullable(),
        }),
        access: config.access.sellers,
        effects: { data: [PaymentEntityName.Client], events: [], external, ai: false },
        audit: { event: 'payments.client.save_method' },
        async handler(ctx, input) {
          const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
          if (!canTakePayments(runtime, merchant)) {
            throw ctx.errors.conflict('This payment account cannot take payments yet', {
              reason: 'payments_charges_disabled',
              status: merchant.status,
            });
          }
          const client = await ensureClient(
            ctx,
            runtime,
            {
              tenantId: owner.tenantId,
              merchant,
              onPlatform: (merchant.chargeType ?? 'direct') !== 'direct',
              owner,
            },
            input.client,
          );
          const values = { clientId: client.id };
          const page = await createSetupSession({
            sellerAccountId: sellerAccountOf(merchant, client),
            clientId: client.providerClientId,
            reference: client.id,
            successUrl: fillUrl(requireUrl(ctx, runtime, 'setupSuccess'), values),
            cancelUrl: fillUrl(requireUrl(ctx, runtime, 'setupCancel'), values),
            metadata: ownerMetadata(runtime, owner, {
              plumbus_client_id: client.id,
              plumbus_merchant_account_id: merchant.id,
            }),
            idempotencyKey: `plumbus-setup:${client.id}:${randomUUID()}`,
          });
          if (!page.url) {
            throw ctx.errors.internal('The provider returned no page to save the method on', {
              reason: 'payments_no_setup_page',
            });
          }
          return {
            clientId: client.id,
            url: page.url,
            expiresAt: page.expiresAt ? page.expiresAt.toISOString() : null,
          };
        },
      })
    : null;

  const listClientPaymentMethods = defineCapability({
    name: 'listClientPaymentMethods',
    kind: 'query',
    domain: 'payments',
    description: "List a client's saved payment methods (brand and last digits)",
    input: z.object({ clientId: z.string().uuid() }),
    output: z.object({ paymentMethods: z.array(paymentMethodViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Method], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { client } = await requireOwnClient(ctx, input.clientId);
      const rows = await paymentMethods(ctx).findMany(
        { tenantId: ctx.auth.tenantId, clientId: client.id, status: 'active' },
        { orderBy: 'createdAt', orderDir: 'desc', limit: 50 },
      );
      return { paymentMethods: rows.map(paymentMethodView) };
    },
  });

  const listPaymentMethods = provider.listPaymentMethods?.bind(provider);
  const syncClientPaymentMethods = listPaymentMethods
    ? defineCapability({
        name: 'syncClientPaymentMethods',
        kind: 'action',
        domain: 'payments',
        description: "Pull a client's saved payment methods from the provider now",
        input: z.object({ clientId: z.string().uuid() }),
        output: z.object({ paymentMethods: z.array(paymentMethodViewSchema) }),
        access: config.access.sellers,
        effects: { data: [PaymentEntityName.Method], events: [], external, ai: false },
        async handler(ctx, input) {
          const { merchant, client } = await requireOwnClient(ctx, input.clientId);
          const found = await listPaymentMethods({
            sellerAccountId: sellerAccountOf(merchant, client),
            clientId: client.providerClientId,
          });
          const repo = paymentMethods(ctx);
          const known = await repo.findMany({ tenantId: ctx.auth.tenantId, clientId: client.id });
          const seen = new Set(found.map((method) => method.id));
          for (const method of found) {
            const existing = known.find((row) => row.providerMethodId === method.id);
            const fields = {
              type: method.type,
              brand: method.brand,
              last4: method.last4,
              expMonth: method.expMonth,
              expYear: method.expYear,
              status: 'active' as const,
            };
            if (existing) {
              await repo.update(existing.id, fields);
            } else {
              await repo.create({
                id: stableUuid(`plumbus-method:${provider.id}:${method.id}`),
                tenantId: ctx.auth.tenantId,
                clientId: client.id,
                merchantAccountId: merchant.id,
                provider: provider.id,
                providerMethodId: method.id,
                ...fields,
              });
            }
          }
          for (const row of known) {
            if (!seen.has(row.providerMethodId) && row.status === 'active') {
              await repo.update(row.id, { status: 'removed' });
            }
          }
          const rows = await repo.findMany(
            { tenantId: ctx.auth.tenantId, clientId: client.id, status: 'active' },
            { orderBy: 'createdAt', orderDir: 'desc', limit: 50 },
          );
          return { paymentMethods: rows.map(paymentMethodView) };
        },
      })
    : null;

  const detachPaymentMethod = provider.detachPaymentMethod?.bind(provider);
  const removeClientPaymentMethod = detachPaymentMethod
    ? defineCapability({
        name: 'removeClientPaymentMethod',
        kind: 'action',
        domain: 'payments',
        description: "Remove a client's saved payment method",
        input: z.object({ paymentMethodId: z.string().uuid() }),
        output: z.object({ paymentMethod: paymentMethodViewSchema }),
        access: config.access.sellers,
        effects: { data: [PaymentEntityName.Method], events: [], external, ai: false },
        audit: { event: 'payments.client.remove_method', includeInput: ['paymentMethodId'] },
        async handler(ctx, input) {
          const method = await paymentMethods(ctx).findById(input.paymentMethodId);
          if (!method) {
            throw ctx.errors.notFound('Payment method not found', {
              reason: 'payments_payment_method_not_found',
            });
          }
          const { merchant, client } = await requireOwnClient(ctx, method.clientId);
          if (method.status === 'active') {
            await detachPaymentMethod({
              sellerAccountId: sellerAccountOf(merchant, client),
              methodId: method.providerMethodId,
            });
          }
          const updated = await paymentMethods(ctx).update(method.id, { status: 'removed' });
          return { paymentMethod: paymentMethodView(updated) };
        },
      })
    : null;

  const createPortalSession = provider.createPortalSession?.bind(provider);
  const createClientPortalSession = createPortalSession
    ? defineCapability({
        name: 'createClientPortalSession',
        kind: 'action',
        domain: 'payments',
        description:
          "A link to the provider's self-service portal for one client (payment methods, invoices, subscriptions)",
        input: z.object({ clientId: z.string().uuid() }),
        output: z.object({ url: z.string() }),
        access: config.access.sellers,
        effects: { data: [], events: [], external, ai: false },
        async handler(ctx, input) {
          const { merchant, client } = await requireOwnClient(ctx, input.clientId);
          const session = await createPortalSession({
            sellerAccountId: sellerAccountOf(merchant, client),
            clientId: client.providerClientId,
            returnUrl: requireUrl(ctx, runtime, 'portalReturn'),
          });
          return { url: session.url };
        },
      })
    : null;

  return {
    listClients,
    listClientPaymentMethods,
    ...(saveClientPaymentMethod ? { saveClientPaymentMethod } : {}),
    ...(syncClientPaymentMethods ? { syncClientPaymentMethods } : {}),
    ...(removeClientPaymentMethod ? { removeClientPaymentMethod } : {}),
    ...(createClientPortalSession ? { createClientPortalSession } : {}),
  };
}
