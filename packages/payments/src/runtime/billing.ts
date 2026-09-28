// ── Platform billing runtime ──
// The platform billing its own customers (tenants, users, or sellers) for the
// plans in `billing.plans`. The catalog (products, prices, entitlement features,
// usage meters) is derived from config and created at the provider with
// `plumbus payments catalog sync`; prices are found by lookup key
// (`plumbus:<appId>:<plan>:<price>`), so a price change in config makes a new
// provider price while existing subscribers keep theirs.

import { randomUUID } from 'node:crypto';
import type { AICostRecord, ExecutionContext } from '@plumbus/core';
import { ErrorCode, isPlumbusError, PlumbusError, sql } from '@plumbus/core';
import type { CatalogInput } from '../types/provider.js';
import type { PaymentBillingCustomerRow, PaymentSubscriptionRow } from '../types/records.js';
import type { PlatformHelpers } from './platform.js';
import { billingCustomers, entitlements, findOne, stableUuid, subscriptions } from './repos.js';
import {
  type BillingOwner,
  ownerMetadata,
  type PaymentsRuntime,
  PLATFORM_ROUTING,
  resolveBillingOwner,
} from './runtime.js';
import { changeSubscriptionRow, providerItems } from './subscription-engine.js';

const LIVE: ReadonlySet<PaymentSubscriptionRow['status']> = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);

export const namespaceOf = (runtime: PaymentsRuntime) => runtime.config.appId ?? 'app';
export const planLookupKey = (namespace: string, plan: string, price: string) =>
  `plumbus:${namespace}:${plan}:${price}`;
export const meterLookupKey = (namespace: string, meter: string) =>
  `plumbus:${namespace}:meter:${meter}`;

/** The provider catalog `billing` describes, or null without billing. */
export function catalogFor(runtime: PaymentsRuntime): CatalogInput | null {
  const billing = runtime.config.billing;
  if (!billing) return null;
  const namespace = namespaceOf(runtime);
  const featureKeys = new Set<string>();
  const plans = Object.entries(billing.plans).map(([key, plan]) => {
    for (const feature of plan.features ?? []) featureKeys.add(feature);
    return {
      key,
      name: plan.name,
      ...(plan.description ? { description: plan.description } : {}),
      features: plan.features ?? [],
      prices: Object.entries(plan.prices).map(([priceKey, price]) => ({
        key: priceKey,
        lookupKey: planLookupKey(namespace, key, priceKey),
        amount: price.amount,
        currency: price.currency,
        interval: price.interval,
        intervalCount: price.intervalCount ?? 1,
        perSeat: price.perSeat ?? false,
      })),
    };
  });
  const meters = Object.entries(billing.meters).map(([key, meter]) => ({
    key,
    lookupKey: meterLookupKey(namespace, key),
    name: meter.name,
    eventName: meter.eventName,
    aggregation: meter.aggregation ?? 'sum',
    unitAmountDecimal: String(meter.unitAmount),
    currency: meter.currency,
    interval: meter.interval ?? 'month',
  }));
  return {
    namespace,
    plans,
    meters,
    features: [...featureKeys].sort().map((feature) => ({
      key: feature,
      name: billing.features[feature]?.name ?? feature,
    })),
  };
}

export async function findBillingCustomer(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: BillingOwner,
): Promise<PaymentBillingCustomerRow | null> {
  return findOne(billingCustomers(ctx), {
    tenantId: owner.tenantId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    provider: runtime.provider.id,
    livemode: await runtime.provider.resolveLivemode(),
  });
}

/** The caller's billing customer, created at the provider on first use. */
export async function ensureBillingCustomer(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: BillingOwner,
  email?: string,
): Promise<PaymentBillingCustomerRow> {
  const existing = await findBillingCustomer(ctx, runtime, owner);
  if (existing) return existing;
  const { provider } = runtime;
  if (!provider.createBillingCustomer) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `${provider.displayName} does not support billing`,
      {
        reason: 'payments_provider_feature_unsupported',
      },
    );
  }
  const livemode = await provider.resolveLivemode();
  // One id per owner, so concurrent first calls create one customer.
  const id = stableUuid(
    `plumbus-billing-customer:${owner.tenantId}:${owner.ownerType}:${owner.ownerId}:${livemode}`,
  );
  const created = await provider.createBillingCustomer({
    ...(email ? { email } : {}),
    metadata: ownerMetadata(runtime, owner, { plumbus_billing_customer_id: id }),
    idempotencyKey: `plumbus-billing-customer:${id}`,
  });
  try {
    return await billingCustomers(ctx).create({
      id,
      tenantId: owner.tenantId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      provider: provider.id,
      providerCustomerId: created.customerId,
      email: email ?? null,
      livemode,
    });
  } catch (err) {
    const winner = await billingCustomers(ctx).findById(id);
    if (winner) return winner;
    throw err;
  }
}

/**
 * The provider no longer has a saved customer: the app moved to another
 * provider account in the same mode, or a test account was reset. Providers
 * report it with this reason (see `PaymentProvider`).
 */
export const PROVIDER_CUSTOMER_MISSING = 'payments_provider_customer_missing';

export function isMissingProviderCustomer(err: unknown): boolean {
  return isPlumbusError(err) && err.metadata?.reason === PROVIDER_CUSTOMER_MISSING;
}

/**
 * Make a new provider customer for a billing customer whose provider customer
 * is gone, and keep the same row (its subscriptions and charges stay linked).
 * Keyed by the id it replaces, so concurrent replacements make one customer.
 */
export async function replaceBillingCustomer(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: BillingOwner,
  customer: PaymentBillingCustomerRow,
  email?: string,
): Promise<PaymentBillingCustomerRow> {
  const { provider } = runtime;
  if (!provider.createBillingCustomer)
    throw new PlumbusError(
      ErrorCode.Validation,
      `${provider.displayName} does not support billing`,
      { reason: 'payments_provider_feature_unsupported' },
    );
  const address = email ?? customer.email ?? undefined;
  const created = await provider.createBillingCustomer({
    ...(address ? { email: address } : {}),
    metadata: ownerMetadata(runtime, owner, { plumbus_billing_customer_id: customer.id }),
    idempotencyKey: `plumbus-billing-customer:${customer.id}:replaces:${customer.providerCustomerId}`,
  });
  return billingCustomers(ctx).update(customer.id, {
    providerCustomerId: created.customerId,
    ...(email ? { email } : {}),
  });
}

/**
 * Run a provider call with the owner's billing customer. When the provider no
 * longer has that customer, replace it once and run the call again (the calls
 * that use this remove their own row on failure, so the retry starts clean).
 */
export async function withBillingCustomer<T>(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  owner: BillingOwner,
  customer: PaymentBillingCustomerRow,
  email: string | undefined,
  call: (customer: PaymentBillingCustomerRow) => Promise<T>,
): Promise<T> {
  try {
    return await call(customer);
  } catch (err) {
    if (!isMissingProviderCustomer(err)) throw err;
    return call(await replaceBillingCustomer(ctx, runtime, owner, customer, email));
  }
}

/** A customer's live plan subscription, else their most recent one. */
export async function currentPlanSubscription(
  ctx: ExecutionContext,
  customer: PaymentBillingCustomerRow,
): Promise<PaymentSubscriptionRow | null> {
  const rows = await subscriptions(ctx).findMany(
    { tenantId: customer.tenantId, payee: 'platform', billingCustomerId: customer.id },
    { orderBy: 'createdAt', orderDir: 'desc', limit: 20 },
  );
  return rows.find((row) => LIVE.has(row.status)) ?? rows[0] ?? null;
}

export function isLive(row: PaymentSubscriptionRow | null): row is PaymentSubscriptionRow {
  return row !== null && LIVE.has(row.status);
}

export interface UsageInput {
  /** Key of `billing.meters`. */
  meter: string;
  value: number;
  /** Dedupe key: the provider counts one event per identifier. */
  identifier?: string;
  timestamp?: Date;
  /** Bill another owner than the caller (background jobs). */
  owner?: Omit<BillingOwner, 'tenantId'>;
}

export function createBillingHelpers(runtime: PaymentsRuntime, platform: PlatformHelpers) {
  const { config, provider } = runtime;

  function requireBilling() {
    if (!config.billing) {
      throw new PlumbusError(ErrorCode.Validation, 'Configure billing in createPayments() first', {
        reason: 'payments_billing_disabled',
      });
    }
    return config.billing;
  }

  async function ownerOf(
    ctx: ExecutionContext,
    explicit?: Omit<BillingOwner, 'tenantId'>,
  ): Promise<BillingOwner> {
    if (!explicit) return resolveBillingOwner(ctx, runtime);
    const tenantId = ctx.auth.tenantId;
    if (!tenantId) {
      throw ctx.errors.forbidden('Payments need a tenant context (auth.tenantId)', {
        reason: 'payments_tenant_required',
      });
    }
    return { tenantId, ...explicit };
  }

  /** Features the caller's plan grants right now. */
  async function features(
    ctx: ExecutionContext,
    owner?: Omit<BillingOwner, 'tenantId'>,
  ): Promise<string[]> {
    requireBilling();
    const customer = await findBillingCustomer(ctx, runtime, await ownerOf(ctx, owner));
    if (!customer) return [];
    const rows = await entitlements(ctx).findMany(
      { tenantId: customer.tenantId, billingCustomerId: customer.id },
      { limit: 1000 },
    );
    return rows.map((row) => row.feature).sort();
  }

  return {
    /** Features of the caller's plan (from entitlement webhooks). */
    features,

    /** Whether the caller's plan grants a feature. Use it to gate your own capabilities. */
    async hasFeature(
      ctx: ExecutionContext,
      feature: string,
      owner?: Omit<BillingOwner, 'tenantId'>,
    ): Promise<boolean> {
      return (await features(ctx, owner)).includes(feature);
    },

    /** Set the seat count of the caller's per-seat plan (e.g. the tenant's member count). */
    async setSeats(
      ctx: ExecutionContext,
      input: { quantity: number; owner?: Omit<BillingOwner, 'tenantId'> },
    ): Promise<PaymentSubscriptionRow> {
      const billing = requireBilling();
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
        throw ctx.errors.validation('quantity must be a whole number of at least 1', {
          reason: 'payments_invalid_quantity',
        });
      }
      const customer = await findBillingCustomer(ctx, runtime, await ownerOf(ctx, input.owner));
      const row = customer ? await currentPlanSubscription(ctx, customer) : null;
      if (!isLive(row) || !row.plan || !row.planPrice) {
        throw ctx.errors.conflict('There is no live plan subscription to set seats on', {
          reason: 'payments_no_plan_subscription',
        });
      }
      const price = billing.plans[row.plan]?.prices[row.planPrice];
      if (!price?.perSeat) {
        throw ctx.errors.conflict(`The ${row.plan} plan is not priced per seat`, {
          reason: 'payments_plan_not_per_seat',
        });
      }
      if (row.quantity === input.quantity) return row;
      const lookupKey = planLookupKey(namespaceOf(runtime), row.plan, row.planPrice);
      const item = (await providerItems(ctx, runtime, row, PLATFORM_ROUTING)).find(
        (candidate) => candidate.lookupKey === lookupKey,
      );
      if (!item) {
        throw ctx.errors.conflict('The plan item is missing from the subscription', {
          reason: 'payments_plan_item_missing',
        });
      }
      return changeSubscriptionRow(
        ctx,
        runtime,
        row,
        PLATFORM_ROUTING,
        [{ itemId: item.id, quantity: input.quantity }],
        billing.prorate,
      );
    },

    /** Record usage on a meter for the caller (or `owner`). */
    async recordUsage(ctx: ExecutionContext, input: UsageInput): Promise<void> {
      const billing = requireBilling();
      const meter = billing.meters[input.meter];
      if (!meter) {
        throw ctx.errors.validation(`Unknown meter "${input.meter}"`, {
          reason: 'payments_unknown_meter',
        });
      }
      if (!Number.isFinite(input.value) || input.value < 0) {
        throw ctx.errors.validation('Usage values are non-negative numbers', {
          reason: 'payments_invalid_usage',
        });
      }
      if (!provider.recordUsage) {
        throw new PlumbusError(
          ErrorCode.Validation,
          `${provider.displayName} does not meter usage`,
          {
            reason: 'payments_provider_feature_unsupported',
          },
        );
      }
      const customer = await findBillingCustomer(ctx, runtime, await ownerOf(ctx, input.owner));
      if (!customer) {
        throw ctx.errors.conflict('This customer has no billing account yet (no plan)', {
          reason: 'payments_no_billing_customer',
        });
      }
      await provider.recordUsage({
        customerId: customer.providerCustomerId,
        eventName: meter.eventName,
        value: input.value,
        identifier: input.identifier ?? randomUUID(),
        timestamp: input.timestamp ?? ctx.time.now(),
      });
    },

    /** A one-off purchase from the platform, billed to the caller's billing customer. */
    async purchase(
      ctx: ExecutionContext,
      input: Omit<Parameters<PlatformHelpers['createCharge']>[1], 'client' | 'billingCustomer'> & {
        email?: string;
      },
    ) {
      requireBilling();
      const { email, ...charge } = input;
      const owner = await ownerOf(ctx);
      const customer = await ensureBillingCustomer(ctx, runtime, owner, email);
      return withBillingCustomer(ctx, runtime, owner, customer, email, (current) =>
        platform.createCharge(ctx, {
          ...charge,
          billingCustomer: { id: current.id, providerCustomerId: current.providerCustomerId },
        }),
      );
    },

    /**
     * An `onAICostRecorded` hook (app/server.ts) that meters every AI call of a
     * tenant or user onto `meter`: tokens, or cost in millionths of a dollar.
     * Calls without a billing customer are skipped; errors never reach the AI call.
     */
    aiUsageBridge(options: {
      meter: string;
      value: 'tokens' | 'costMicros' | ((record: AICostRecord) => number | null);
    }) {
      const billing = requireBilling();
      const meter = billing.meters[options.meter];
      if (!meter) throw new PlumbusError(ErrorCode.Validation, `Unknown meter "${options.meter}"`);
      if (billing.customer === 'seller') {
        throw new PlumbusError(
          ErrorCode.Validation,
          'aiUsageBridge meters tenants or users; billing.customer is "seller"',
        );
      }
      const measure = (record: AICostRecord): number | null => {
        if (typeof options.value === 'function') return options.value(record);
        if (options.value === 'tokens') return record.usage.totalTokens;
        return record.cost === null ? null : Math.round(record.cost * 1_000_000);
      };
      return async (
        record: AICostRecord,
        _costContext: unknown,
        db: { execute(query: unknown): Promise<unknown> },
      ): Promise<void> => {
        const value = measure(record);
        const ownerId = billing.customer === 'tenant' ? record.tenantId : record.actor;
        if (!value || value <= 0 || !record.tenantId || !ownerId || !provider.recordUsage) return;
        const result = (await db.execute(sql`
          select provider_customer_id from payment_billing_customer
          where tenant_id = ${record.tenantId} and owner_type = ${billing.customer}
            and owner_id = ${ownerId} and provider = ${provider.id}
            and livemode = ${await provider.resolveLivemode()}
          limit 1`)) as unknown as
          | Array<{ provider_customer_id: string }>
          | { rows?: Array<{ provider_customer_id: string }> };
        const rows = Array.isArray(result) ? result : (result.rows ?? []);
        const customerId = rows[0]?.provider_customer_id;
        if (!customerId) return;
        await provider.recordUsage({
          customerId,
          eventName: meter.eventName,
          value,
          identifier: `plumbus-ai:${record.id}`,
          timestamp: record.timestamp,
        });
      };
    },
  };
}

export type BillingHelpers = ReturnType<typeof createBillingHelpers>;
