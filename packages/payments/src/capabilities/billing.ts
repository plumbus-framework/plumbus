// ── Platform billing capabilities ──
// Your customers (the tenant, each user, or each seller) subscribe to your
// plans on a provider checkout page, then change plan, cancel, resume, or
// manage payment methods and invoices in the provider's billing portal.
// Entitlements (plan features) follow the provider and gate your own
// capabilities through `payments.billing.hasFeature(ctx, feature)`.
// Created when `billing` is configured.

import type { ExecutionContext } from '@plumbus/core';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { PaymentEventName } from '../events/index.js';
import {
  currentPlanSubscription,
  ensureBillingCustomer,
  findBillingCustomer,
  isLive,
  meterLookupKey,
  namespaceOf,
  planLookupKey,
} from '../runtime/billing.js';
import { entitlements, invoices } from '../runtime/repos.js';
import {
  invoiceView,
  ownerMetadata,
  type PaymentsRuntime,
  PLATFORM_ROUTING,
  requireUrl,
  resolveBillingOwner,
  subscriptionView,
} from '../runtime/runtime.js';
import {
  cancelSubscriptionRow,
  changeSubscriptionRow,
  providerItems,
  resumeSubscriptionRow,
  startSubscription,
  subscriptionForRequest,
} from '../runtime/subscription-engine.js';
import type { NormalizedPaymentsConfig } from '../types/config.js';
import type { PaymentSubscriptionRow } from '../types/records.js';
import { intervalSchema, invoiceViewSchema, subscriptionViewSchema } from './schemas.js';

const planChoice = z.object({
  plan: z.string().min(1).max(40),
  price: z.string().min(1).max(40).describe('Key of the plan price, e.g. "monthly"'),
  quantity: z.number().int().min(1).max(100_000).optional().describe('Seats, for per-seat prices'),
});

export function createBillingCapabilities(runtime: PaymentsRuntime) {
  const { config, provider } = runtime;
  const billing = config.billing as NonNullable<NormalizedPaymentsConfig['billing']>;
  const external = [`payments:${provider.id}`];
  const namespace = namespaceOf(runtime);
  const subscriptionEvents = [
    PaymentEventName.SubscriptionStarted,
    PaymentEventName.SubscriptionUpdated,
    PaymentEventName.SubscriptionEnded,
  ];

  function requirePlan(
    ctx: ExecutionContext,
    input: { plan: string; price: string; quantity?: number },
  ) {
    const plan = billing.plans[input.plan];
    const price = plan?.prices[input.price];
    if (!plan || !price) {
      throw ctx.errors.validation(`Unknown plan price ${input.plan}/${input.price}`, {
        reason: 'payments_unknown_plan',
      });
    }
    if (input.quantity !== undefined && !price.perSeat) {
      throw ctx.errors.validation(`The ${input.plan} plan is not priced per seat`, {
        reason: 'payments_plan_not_per_seat',
      });
    }
    return { plan, price, quantity: price.perSeat ? (input.quantity ?? 1) : 1 };
  }

  async function requireLiveSubscription(ctx: ExecutionContext): Promise<PaymentSubscriptionRow> {
    const owner = await resolveBillingOwner(ctx, runtime);
    const customer = await findBillingCustomer(ctx, runtime, owner);
    const row = customer ? await currentPlanSubscription(ctx, customer) : null;
    if (!isLive(row)) {
      throw ctx.errors.conflict('There is no live plan subscription', {
        reason: 'payments_no_plan_subscription',
      });
    }
    return row;
  }

  const listPlans = defineCapability({
    name: 'listPlans',
    kind: 'query',
    domain: 'payments',
    description: 'The plans you sell, with prices and features (for a pricing page)',
    input: z.object({}),
    output: z.object({
      plans: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          description: z.string().nullable(),
          features: z.array(z.object({ key: z.string(), name: z.string() })),
          trialDays: z.number().int().nullable(),
          prices: z.array(
            z.object({
              key: z.string(),
              amount: z.number().int(),
              currency: z.string(),
              interval: intervalSchema,
              intervalCount: z.number().int(),
              perSeat: z.boolean(),
            }),
          ),
        }),
      ),
    }),
    access: config.access.entitlements,
    effects: { data: [], events: [], external: [], ai: false },
    async handler() {
      return {
        plans: Object.entries(billing.plans).map(([key, plan]) => ({
          key,
          name: plan.name,
          description: plan.description ?? null,
          features: (plan.features ?? []).map((feature) => ({
            key: feature,
            name: billing.features[feature]?.name ?? feature,
          })),
          trialDays: plan.trialDays ?? billing.trialDays ?? null,
          prices: Object.entries(plan.prices).map(([priceKey, price]) => ({
            key: priceKey,
            amount: price.amount,
            currency: price.currency,
            interval: price.interval,
            intervalCount: price.intervalCount ?? 1,
            perSeat: price.perSeat ?? false,
          })),
        })),
      };
    },
  });

  const subscribeToPlan = defineCapability({
    name: 'subscribeToPlan',
    kind: 'action',
    domain: 'payments',
    description: 'Start a plan subscription; the customer pays on a provider checkout page',
    input: planChoice.extend({
      email: z.string().email().optional().describe('Pre-fills the checkout page'),
      ui: z.enum(['hosted', 'embedded']).optional(),
      requestId: z.string().min(1).max(100).optional(),
    }),
    output: z.object({ subscription: subscriptionViewSchema, created: z.boolean() }),
    access: config.access.billing,
    effects: {
      data: [PaymentEntityName.Subscription, PaymentEntityName.BillingCustomer],
      events: [],
      external,
      ai: false,
    },
    audit: {
      event: 'payments.billing.subscribe',
      includeInput: ['plan', 'price', 'quantity', 'requestId'],
      includeOutput: ['created'],
    },
    async handler(ctx, input) {
      const { plan, price, quantity } = requirePlan(ctx, input);
      const owner = await resolveBillingOwner(ctx, runtime);
      const customer = await ensureBillingCustomer(ctx, runtime, owner, input.email);
      const party = {
        tenantId: owner.tenantId,
        payee: 'platform' as const,
        merchantAccountId: null,
        billingCustomerId: customer.id,
        owner,
        routing: PLATFORM_ROUTING,
      };
      if (input.requestId) {
        const existing = await subscriptionForRequest(ctx, party, input.requestId);
        if (existing) return { subscription: subscriptionView(existing), created: false };
      }
      const current = await currentPlanSubscription(ctx, customer);
      if (isLive(current)) {
        throw ctx.errors.conflict('Already subscribed; use changePlan to switch plans', {
          reason: 'payments_already_subscribed',
          subscriptionId: current.id,
        });
      }
      const ui = input.ui ?? config.checkout.ui;
      const success = requireUrl(ctx, runtime, 'billingSuccess');
      const row = await startSubscription(ctx, runtime, party, {
        client: null,
        providerCustomerId: customer.providerCustomerId,
        currency: price.currency,
        items: [
          { lookupKey: planLookupKey(namespace, input.plan, input.price), quantity },
          ...(plan.meters ?? []).map((meter) => ({ lookupKey: meterLookupKey(namespace, meter) })),
        ],
        preview: [
          {
            priceId: '',
            lookupKey: planLookupKey(namespace, input.plan, input.price),
            name: plan.name,
            unitAmount: price.amount,
            interval: price.interval,
            intervalCount: price.intervalCount ?? 1,
            quantity,
            metered: false,
          },
        ],
        plan: input.plan,
        planPrice: input.price,
        quantity,
        trialDays: plan.trialDays ?? billing.trialDays,
        applicationFeePercent: null,
        ui,
        urls: {
          success,
          cancel: requireUrl(ctx, runtime, 'billingCancel'),
          return: success,
        },
        options: {
          allowPromotionCodes: billing.allowPromotionCodes,
          automaticTax: billing.automaticTax,
          ...(config.checkout.locale ? { locale: config.checkout.locale } : {}),
        },
        requestId: input.requestId ?? null,
        metadata: null,
        providerMetadata: ownerMetadata(runtime, owner, {
          plumbus_billing_customer_id: customer.id,
        }),
        createdBy: ctx.auth.userId ?? null,
      });
      return { subscription: subscriptionView(row), created: true };
    },
  });

  const getPlanSubscription = defineCapability({
    name: 'getPlanSubscription',
    kind: 'query',
    domain: 'payments',
    description:
      "The caller's plan subscription (live, else the latest), its invoices, and features",
    input: z.object({}),
    output: z.object({
      subscription: subscriptionViewSchema.nullable(),
      invoices: z.array(invoiceViewSchema),
      features: z.array(z.string()),
    }),
    access: config.access.entitlements,
    effects: {
      data: [
        PaymentEntityName.Subscription,
        PaymentEntityName.Invoice,
        PaymentEntityName.BillingCustomer,
        PaymentEntityName.Entitlement,
      ],
      events: [],
      external: [],
      ai: false,
    },
    async handler(ctx) {
      const owner = await resolveBillingOwner(ctx, runtime);
      const customer = await findBillingCustomer(ctx, runtime, owner);
      if (!customer) return { subscription: null, invoices: [], features: [] };
      const row = await currentPlanSubscription(ctx, customer);
      const invoiceRows = row
        ? await invoices(ctx).findMany(
            { tenantId: owner.tenantId, subscriptionId: row.id },
            { orderBy: 'createdAt', orderDir: 'desc', limit: 24 },
          )
        : [];
      const featureRows = await entitlements(ctx).findMany(
        { tenantId: owner.tenantId, billingCustomerId: customer.id },
        { limit: 1000 },
      );
      return {
        subscription: row ? subscriptionView(row) : null,
        invoices: invoiceRows.map(invoiceView),
        features: featureRows.map((r) => r.feature).sort(),
      };
    },
  });

  const changePlan = defineCapability({
    name: 'changePlan',
    kind: 'action',
    domain: 'payments',
    description: 'Switch the live plan subscription to another plan or price (prorated)',
    input: planChoice,
    output: z.object({ subscription: subscriptionViewSchema }),
    access: config.access.billing,
    effects: {
      data: [PaymentEntityName.Subscription],
      events: subscriptionEvents,
      external,
      ai: false,
    },
    audit: { event: 'payments.billing.change_plan', includeInput: ['plan', 'price', 'quantity'] },
    async handler(ctx, input) {
      const { plan, quantity } = requirePlan(ctx, input);
      const row = await requireLiveSubscription(ctx);
      const current = await providerItems(ctx, runtime, row, PLATFORM_ROUTING);
      const wantedMeters = new Set(
        (plan.meters ?? []).map((meter) => meterLookupKey(namespace, meter)),
      );
      const licensed = current.find((item) => !item.metered);
      const items = [
        {
          ...(licensed ? { itemId: licensed.id } : {}),
          lookupKey: planLookupKey(namespace, input.plan, input.price),
          quantity,
        },
        // Meters of the old plan go; meters of the new plan come.
        ...current
          .filter((item) => item.metered && !wantedMeters.has(item.lookupKey ?? ''))
          .map((item) => ({ itemId: item.id, deleted: true })),
        ...[...wantedMeters]
          .filter((lookupKey) => !current.some((item) => item.lookupKey === lookupKey))
          .map((lookupKey) => ({ lookupKey })),
      ];
      const updated = await changeSubscriptionRow(
        ctx,
        runtime,
        row,
        PLATFORM_ROUTING,
        items,
        billing.prorate,
      );
      return { subscription: subscriptionView(updated) };
    },
  });

  const cancelPlanSubscription = defineCapability({
    name: 'cancelPlanSubscription',
    kind: 'action',
    domain: 'payments',
    description: 'Cancel the plan subscription now or at the end of the paid period',
    input: z.object({
      atPeriodEnd: z.boolean().optional().describe('Default true: keep it until the period ends'),
    }),
    output: z.object({ subscription: subscriptionViewSchema }),
    access: config.access.billing,
    effects: {
      data: [PaymentEntityName.Subscription],
      events: subscriptionEvents,
      external,
      ai: false,
    },
    audit: { event: 'payments.billing.cancel', includeInput: ['atPeriodEnd'] },
    async handler(ctx, input) {
      const owner = await resolveBillingOwner(ctx, runtime);
      const customer = await findBillingCustomer(ctx, runtime, owner);
      const row = customer ? await currentPlanSubscription(ctx, customer) : null;
      if (!row) {
        throw ctx.errors.conflict('There is no plan subscription', {
          reason: 'payments_no_plan_subscription',
        });
      }
      const updated = await cancelSubscriptionRow(
        ctx,
        runtime,
        row,
        PLATFORM_ROUTING,
        input.atPeriodEnd ?? true,
      );
      return { subscription: subscriptionView(updated) };
    },
  });

  const resumePlanSubscription = defineCapability({
    name: 'resumePlanSubscription',
    kind: 'action',
    domain: 'payments',
    description: 'Keep a plan subscription that was set to cancel at the end of the period',
    input: z.object({}),
    output: z.object({ subscription: subscriptionViewSchema }),
    access: config.access.billing,
    effects: {
      data: [PaymentEntityName.Subscription],
      events: subscriptionEvents,
      external,
      ai: false,
    },
    audit: { event: 'payments.billing.resume' },
    async handler(ctx) {
      const row = await requireLiveSubscription(ctx);
      const updated = await resumeSubscriptionRow(ctx, runtime, row, PLATFORM_ROUTING);
      return { subscription: subscriptionView(updated) };
    },
  });

  const openBillingPortal = defineCapability({
    name: 'openBillingPortal',
    kind: 'action',
    domain: 'payments',
    description: "A link to the provider's billing portal: payment methods, invoices, plan changes",
    input: z.object({}),
    output: z.object({ url: z.string() }),
    access: config.access.billing,
    effects: { data: [PaymentEntityName.BillingCustomer], events: [], external, ai: false },
    async handler(ctx) {
      const owner = await resolveBillingOwner(ctx, runtime);
      const customer = await findBillingCustomer(ctx, runtime, owner);
      if (!customer || !provider.createPortalSession) {
        throw ctx.errors.conflict('There is no billing account yet; subscribe to a plan first', {
          reason: 'payments_no_billing_customer',
        });
      }
      const session = await provider.createPortalSession({
        sellerAccountId: null,
        clientId: customer.providerCustomerId,
        returnUrl: requireUrl(ctx, runtime, 'billingPortalReturn'),
      });
      return { url: session.url };
    },
  });

  const getEntitlements = defineCapability({
    name: 'getEntitlements',
    kind: 'query',
    domain: 'payments',
    description: "Features the caller's plan grants right now",
    input: z.object({}),
    output: z.object({ features: z.array(z.string()) }),
    access: config.access.entitlements,
    effects: {
      data: [PaymentEntityName.BillingCustomer, PaymentEntityName.Entitlement],
      events: [],
      external: [],
      ai: false,
    },
    async handler(ctx) {
      const owner = await resolveBillingOwner(ctx, runtime);
      const customer = await findBillingCustomer(ctx, runtime, owner);
      if (!customer) return { features: [] };
      const rows = await entitlements(ctx).findMany(
        { tenantId: owner.tenantId, billingCustomerId: customer.id },
        { limit: 1000 },
      );
      return { features: rows.map((row) => row.feature).sort() };
    },
  });

  return {
    listPlans,
    subscribeToPlan,
    getPlanSubscription,
    changePlan,
    cancelPlanSubscription,
    resumePlanSubscription,
    openBillingPortal,
    getEntitlements,
  };
}
