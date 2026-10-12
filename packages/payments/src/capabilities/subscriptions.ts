// ── Seller subscription capabilities ──
// A seller's client pays every week, month, or year (tutoring plans, memberships).
// The client subscribes on a provider checkout page; your cut is a percentage of
// every payment (subscriptions.platformFeePercent). Created when
// `subscriptions.enabled` is set.

import type { ExecutionContext } from '@plumbus/core';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { PaymentEventName } from '../events/index.js';
import { checkoutOptions } from '../runtime/charge-engine.js';
import { ensureClient } from '../runtime/clients.js';
import { invoices, subscriptions } from '../runtime/repos.js';
import {
  canTakePayments,
  computeSubscriptionFee,
  feeMerchant,
  invoiceView,
  ownerMetadata,
  type PaymentsRuntime,
  requireOwnMerchant,
  requireUrl,
  sellerRouting,
  subscriptionView,
} from '../runtime/runtime.js';
import {
  cancelSubscriptionRow,
  resumeSubscriptionRow,
  type SubscriptionParty,
  startSubscription,
  subscriptionForRequest,
  syncSubscriptionRow,
} from '../runtime/subscription-engine.js';
import type { PaymentMerchantAccountRow, PaymentSubscriptionRow } from '../types/records.js';
import { clientInputSchema } from './charges.js';
import {
  amountSchema,
  currencySchema,
  intervalSchema,
  invoiceViewSchema,
  metadataSchema,
  subscriptionStatusSchema,
  subscriptionViewSchema,
} from './schemas.js';

const subscriptionItemInput = z.object({
  name: z.string().min(1).max(250),
  unitAmount: amountSchema.describe('Minor units per period'),
  interval: intervalSchema,
  intervalCount: z.number().int().min(1).max(36).optional(),
  quantity: z.number().int().min(1).max(10_000).optional(),
});

export function createSubscriptionCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const external = [`payments:${provider.id}`];
  const subscriptionEvents = [
    PaymentEventName.SubscriptionStarted,
    PaymentEventName.SubscriptionUpdated,
    PaymentEventName.SubscriptionEnded,
  ];

  async function requireOwnSubscription(
    ctx: ExecutionContext,
    subscriptionId: string,
  ): Promise<{ merchant: PaymentMerchantAccountRow; subscription: PaymentSubscriptionRow }> {
    const { merchant } = await requireOwnMerchant(ctx, runtime);
    const subscription = await subscriptions(ctx).findById(subscriptionId);
    if (
      !subscription ||
      subscription.payee !== 'seller' ||
      subscription.merchantAccountId !== merchant.id
    ) {
      throw ctx.errors.notFound('Subscription not found', {
        reason: 'payments_subscription_not_found',
      });
    }
    return { merchant, subscription };
  }

  const createSubscription = defineCapability({
    name: 'createSubscription',
    kind: 'action',
    domain: 'payments',
    description:
      "Start a recurring payment from one client to the caller's seller account; the client subscribes on a provider page",
    input: z.object({
      client: clientInputSchema,
      currency: currencySchema,
      items: z.array(subscriptionItemInput).min(1).max(20),
      trialDays: z.number().int().min(1).max(730).optional(),
      ui: z.enum(['hosted', 'embedded']).optional(),
      options: z
        .object({
          allowPromotionCodes: z.boolean().optional(),
          automaticTax: z.boolean().optional(),
          locale: z.string().min(2).max(10).optional(),
        })
        .optional(),
      metadata: metadataSchema.optional(),
      requestId: z.string().min(1).max(100).optional(),
    }),
    output: z.object({ subscription: subscriptionViewSchema, created: z.boolean() }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Subscription, PaymentEntityName.Client],
      events: [],
      external,
      ai: false,
    },
    audit: {
      event: 'payments.subscription.create',
      includeInput: ['currency', 'trialDays', 'requestId'],
      includeOutput: ['created'],
    },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      if (!canTakePayments(runtime, merchant)) {
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
      const routing = sellerRouting(runtime, merchant);
      const party: SubscriptionParty = {
        tenantId: owner.tenantId,
        payee: 'seller',
        merchantAccountId: merchant.id,
        billingCustomerId: null,
        owner,
        routing,
      };
      if (input.requestId) {
        const existing = await subscriptionForRequest(ctx, party, input.requestId);
        if (existing) return { subscription: subscriptionView(existing), created: false };
      }
      const ui = input.ui ?? config.checkout.ui;
      const client = await ensureClient(
        ctx,
        runtime,
        { tenantId: owner.tenantId, merchant, onPlatform: routing.flow !== 'direct', owner },
        input.client,
      );
      const fee = await computeSubscriptionFee(ctx, runtime, {
        currency: input.currency,
        flow: routing.flow,
        merchant: feeMerchant(merchant),
      });
      const row = await startSubscription(ctx, runtime, party, {
        client,
        providerCustomerId: client.providerClientId,
        currency: input.currency,
        items: input.items.map((item) => ({
          inline: {
            name: item.name,
            unitAmount: item.unitAmount,
            interval: item.interval,
            intervalCount: item.intervalCount ?? 1,
          },
          quantity: item.quantity ?? 1,
        })),
        preview: input.items.map((item) => ({
          priceId: '',
          lookupKey: null,
          name: item.name,
          unitAmount: item.unitAmount,
          interval: item.interval,
          intervalCount: item.intervalCount ?? 1,
          quantity: item.quantity ?? 1,
          metered: false,
        })),
        plan: null,
        planPrice: null,
        quantity: input.items[0]?.quantity ?? 1,
        trialDays: input.trialDays ?? null,
        applicationFeePercent: fee > 0 ? fee : null,
        ui,
        urls: {
          success: ui === 'hosted' ? requireUrl(ctx, runtime, 'checkoutSuccess') : '',
          cancel: ui === 'hosted' ? requireUrl(ctx, runtime, 'checkoutCancel') : '',
          return: ui === 'embedded' ? requireUrl(ctx, runtime, 'checkoutReturn') : '',
        },
        options: checkoutOptions(runtime, input.options),
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? null,
        providerMetadata: ownerMetadata(runtime, owner, {
          plumbus_merchant_account_id: merchant.id,
          plumbus_client_id: client.id,
        }),
        createdBy: ctx.auth.userId ?? null,
      });
      return { subscription: subscriptionView(row), created: true };
    },
  });

  const listSubscriptions = defineCapability({
    name: 'listSubscriptions',
    kind: 'query',
    domain: 'payments',
    description: "List subscriptions of the caller's clients, newest first",
    input: z.object({
      status: subscriptionStatusSchema.optional(),
      clientId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    output: z.object({ subscriptions: z.array(subscriptionViewSchema) }),
    access: config.access.sellers,
    effects: { data: [PaymentEntityName.Subscription], events: [], external: [], ai: false },
    async handler(ctx, input) {
      const { owner, merchant } = await requireOwnMerchant(ctx, runtime);
      const rows = await subscriptions(ctx).findMany(
        {
          tenantId: owner.tenantId,
          payee: 'seller',
          merchantAccountId: merchant.id,
          ...(input.status ? { status: input.status } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
        },
        {
          orderBy: 'createdAt',
          orderDir: 'desc',
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        },
      );
      return { subscriptions: rows.map(subscriptionView) };
    },
  });

  const getSubscription = defineCapability({
    name: 'getSubscription',
    kind: 'query',
    domain: 'payments',
    description: 'Read one client subscription and its invoices',
    input: z.object({ subscriptionId: z.string().uuid() }),
    output: z.object({
      subscription: subscriptionViewSchema,
      invoices: z.array(invoiceViewSchema),
    }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Subscription, PaymentEntityName.Invoice],
      events: [],
      external: [],
      ai: false,
    },
    async handler(ctx, input) {
      const { subscription } = await requireOwnSubscription(ctx, input.subscriptionId);
      const rows = await invoices(ctx).findMany(
        { tenantId: ctx.auth.tenantId, subscriptionId: subscription.id },
        { orderBy: 'createdAt', orderDir: 'desc', limit: 100 },
      );
      return { subscription: subscriptionView(subscription), invoices: rows.map(invoiceView) };
    },
  });

  const cancelSubscription = defineCapability({
    name: 'cancelSubscription',
    kind: 'action',
    domain: 'payments',
    description: 'Cancel a client subscription now or at the end of the paid period',
    input: z.object({
      subscriptionId: z.string().uuid(),
      atPeriodEnd: z.boolean().optional().describe('Default true: keep it until the period ends'),
    }),
    output: z.object({ subscription: subscriptionViewSchema }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Subscription],
      events: subscriptionEvents,
      external,
      ai: false,
    },
    audit: {
      event: 'payments.subscription.cancel',
      includeInput: ['subscriptionId', 'atPeriodEnd'],
    },
    async handler(ctx, input) {
      const { merchant, subscription } = await requireOwnSubscription(ctx, input.subscriptionId);
      const row = await cancelSubscriptionRow(
        ctx,
        runtime,
        subscription,
        sellerRouting(runtime, merchant),
        input.atPeriodEnd ?? true,
      );
      return { subscription: subscriptionView(row) };
    },
  });

  const resumeSubscription = defineCapability({
    name: 'resumeSubscription',
    kind: 'action',
    domain: 'payments',
    description: 'Keep a client subscription that was set to cancel at the end of the period',
    input: z.object({ subscriptionId: z.string().uuid() }),
    output: z.object({ subscription: subscriptionViewSchema }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Subscription],
      events: subscriptionEvents,
      external,
      ai: false,
    },
    audit: { event: 'payments.subscription.resume', includeInput: ['subscriptionId'] },
    async handler(ctx, input) {
      const { merchant, subscription } = await requireOwnSubscription(ctx, input.subscriptionId);
      const row = await resumeSubscriptionRow(
        ctx,
        runtime,
        subscription,
        sellerRouting(runtime, merchant),
      );
      return { subscription: subscriptionView(row) };
    },
  });

  const syncSubscription = defineCapability({
    name: 'syncSubscription',
    kind: 'action',
    domain: 'payments',
    description: 'Pull a client subscription from the provider now',
    input: z.object({ subscriptionId: z.string().uuid() }),
    output: z.object({ subscription: subscriptionViewSchema }),
    access: config.access.sellers,
    effects: {
      data: [PaymentEntityName.Subscription],
      events: subscriptionEvents,
      external,
      ai: false,
    },
    async handler(ctx, input) {
      const { merchant, subscription } = await requireOwnSubscription(ctx, input.subscriptionId);
      const row = await syncSubscriptionRow(
        ctx,
        runtime,
        subscription,
        sellerRouting(runtime, merchant),
      );
      return { subscription: subscriptionView(row) };
    },
  });

  return {
    createSubscription,
    listSubscriptions,
    getSubscription,
    cancelSubscription,
    resumeSubscription,
    syncSubscription,
  };
}
