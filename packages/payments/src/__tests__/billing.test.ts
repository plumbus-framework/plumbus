// The platform billing its own customers for plans: catalog, subscribe, plan
// changes, seats, usage meters, one-off purchases, entitlements, the portal,
// and the AI usage bridge.

import type { AICostRecord } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { MockEventService } from '@plumbus/core/testing';
import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { createPayments } from '../runtime/create-payments.js';
import {
  createFakePaymentProvider,
  createPaymentsTestContext,
  deliverTestWebhook,
  withAuth,
} from '../testing/index.js';
import type { BillingConfig, PaymentsConfig } from '../types/config.js';
import { onboardedSeller, urls } from './helpers.js';

const plans: BillingConfig = {
  customer: 'tenant',
  plans: {
    starter: {
      name: 'Starter',
      features: ['projects'],
      prices: { monthly: { amount: 900, currency: 'usd', interval: 'month' } },
    },
    team: {
      name: 'Team',
      features: ['projects', 'ai'],
      prices: {
        monthly: { amount: 1500, currency: 'usd', interval: 'month', perSeat: true },
        yearly: { amount: 15_000, currency: 'usd', interval: 'year', perSeat: true },
      },
      meters: ['aiTokens'],
    },
  },
  meters: {
    aiTokens: { name: 'AI tokens', eventName: 'ai_tokens', unitAmount: '0.002', currency: 'usd' },
  },
  features: { ai: { name: 'AI assistant' } },
};

function billingEnv(overrides: Partial<PaymentsConfig> = {}) {
  const fake = createFakePaymentProvider();
  const payments = createPayments({
    provider: fake,
    billing: plans,
    access: { billing: { roles: ['admin'] } },
    urls,
    appId: 'myapp',
    ...overrides,
  });
  const ctx = createPaymentsTestContext(payments, {
    auth: { userId: 'admin-1', tenantId: 'tenant-a', roles: ['admin'] },
  });
  const run = async <T = any>(name: string, input: unknown, context = ctx): Promise<T> => {
    const capability = (payments.capabilities as Record<string, any>)[name];
    const result = await executeCapability(capability, context, input);
    if (!result.success) throw result.error;
    return result.data as T;
  };
  const tryRun = (name: string, input: unknown, context = ctx) =>
    executeCapability((payments.capabilities as Record<string, any>)[name], context, input);
  const events = ctx.events as MockEventService;
  const emitted = (name: string) =>
    events.emitted.filter((e) => e.eventName === name).map((e) => e.payload as any);
  const deliver = (type: Parameters<typeof fake.event>[0], id: string) =>
    deliverTestWebhook(payments, ctx, fake.event(type, id));
  const data = ctx.data as any;
  return { fake, payments, ctx, run, tryRun, events, emitted, deliver, data };
}

/** Sync the catalog and subscribe the tenant to a plan through checkout. */
async function subscribed(env: ReturnType<typeof billingEnv>, plan = 'starter', quantity?: number) {
  await env.payments.syncCatalog();
  const { subscription } = await env.run<any>('subscribeToPlan', {
    plan,
    price: 'monthly',
    ...(quantity ? { quantity } : {}),
  });
  const checkout = [...env.fake.subscriptionCheckouts.values()].at(-1);
  if (!checkout) throw new Error('no checkout');
  const sub = env.fake.completeSubscriptionCheckout(checkout.id);
  await env.deliver('subscription_checkout', checkout.id);
  await env.deliver('entitlements', sub.customerId);
  return { subscription, sub, checkout };
}

describe('billing config', () => {
  it('runs without sellers: only billing and internal capabilities', () => {
    const env = billingEnv();
    expect(Object.keys(env.payments.capabilities).sort()).toEqual([
      'applyProviderState',
      'cancelPlanSubscription',
      'changePlan',
      'getEntitlements',
      'getPlanSubscription',
      'listPlans',
      'openBillingPortal',
      'processProviderEvent',
      'recordProviderEvent',
      'resumePlanSubscription',
      'subscribeToPlan',
    ]);
  });

  it('asks who may change a tenant plan, and for the billing urls', () => {
    const fake = createFakePaymentProvider();
    expect(() => createPayments({ provider: fake, billing: plans, access: {}, urls })).toThrow(
      'access.billing is required',
    );
    const { billingSuccess: _s, ...noSuccess } = urls;
    expect(() =>
      createPayments({
        provider: fake,
        billing: plans,
        access: { billing: { roles: ['admin'] } },
        urls: noSuccess,
      }),
    ).toThrow('urls.billingSuccess is required');
  });

  it('refuses a plan billing a meter that does not exist', () => {
    const fake = createFakePaymentProvider();
    expect(() =>
      createPayments({
        provider: fake,
        billing: {
          ...plans,
          plans: {
            x: {
              name: 'X',
              prices: { m: { amount: 1, currency: 'usd', interval: 'month' } },
              meters: ['nope'],
            },
          },
        },
        access: { billing: { roles: ['admin'] } },
        urls,
      }),
    ).toThrow('which billing.meters does not define');
  });

  it('refuses a config with neither sellers nor billing', () => {
    expect(() =>
      createPayments({ provider: createFakePaymentProvider(), access: {}, urls }),
    ).toThrow('Configure seller');
  });
});

describe('catalog', () => {
  it('derives lookup keys from config and syncs them idempotently', async () => {
    const env = billingEnv();
    expect(
      env.payments.catalog?.plans.map((p) => p.prices.map((price) => price.lookupKey)),
    ).toEqual([
      ['plumbus:myapp:starter:monthly'],
      ['plumbus:myapp:team:monthly', 'plumbus:myapp:team:yearly'],
    ]);
    expect(env.payments.catalog?.meters[0]).toMatchObject({
      lookupKey: 'plumbus:myapp:meter:aiTokens',
      unitAmountDecimal: '0.002',
    });
    expect(env.payments.catalog?.features).toEqual([
      { key: 'ai', name: 'AI assistant' },
      { key: 'projects', name: 'projects' },
    ]);
    expect((await env.payments.checkCatalog()).changes).toHaveLength(4);
    const first = await env.payments.syncCatalog();
    expect(first.changes).toHaveLength(4);
    const second = await env.payments.syncCatalog();
    expect(second.changes).toEqual([]);
    expect(await env.payments.checkCatalog()).toEqual({ prices: first.prices, changes: [] });
  });

  it('refuses a catalog sync or check without billing', async () => {
    const env = await onboardedSeller();
    await expect(env.payments.syncCatalog()).rejects.toThrow('Configure billing to sync a catalog');
    await expect(env.payments.checkCatalog()).rejects.toThrow(
      'Configure billing to check a catalog',
    );
  });

  it('lists plans for a pricing page', async () => {
    const env = billingEnv();
    const { plans: listed } = await env.run<any>('listPlans', {});
    expect(listed.map((p: any) => p.key)).toEqual(['starter', 'team']);
    expect(listed[1]).toMatchObject({
      features: [
        { key: 'projects', name: 'projects' },
        { key: 'ai', name: 'AI assistant' },
      ],
      prices: [
        expect.objectContaining({ key: 'monthly', perSeat: true }),
        expect.objectContaining({ key: 'yearly', interval: 'year' }),
      ],
    });
  });
});

describe('plan subscriptions', () => {
  it('subscribes the tenant through checkout and grants the plan features', async () => {
    const env = billingEnv();
    await env.payments.syncCatalog();
    const { subscription } = await env.run<any>('subscribeToPlan', {
      plan: 'team',
      price: 'monthly',
      quantity: 3,
      email: 'owner@acme.test',
    });
    expect(subscription).toMatchObject({ status: 'incomplete', plan: 'team', quantity: 3 });
    const input = [...env.fake.calls]
      .reverse()
      .find((c) => c.method === 'createSubscriptionCheckout')?.input as any;
    expect(input).toMatchObject({
      flow: 'platform',
      sellerAccountId: null,
      successUrl: 'https://app.test/billing/welcome',
      items: [
        { lookupKey: 'plumbus:myapp:team:monthly', quantity: 3 },
        { lookupKey: 'plumbus:myapp:meter:aiTokens' },
      ],
    });
    const customer = (await env.data.PaymentBillingCustomer.findMany({}))[0];
    expect(customer).toMatchObject({
      ownerType: 'tenant',
      ownerId: 'tenant-a',
      email: 'owner@acme.test',
    });

    const checkout = [...env.fake.subscriptionCheckouts.values()][0];
    if (!checkout) throw new Error('no checkout');
    const sub = env.fake.completeSubscriptionCheckout(checkout.id);
    await env.deliver('subscription_checkout', checkout.id);
    await env.deliver('entitlements', sub.customerId);

    const current = await env.run<any>('getPlanSubscription', {});
    expect(current.subscription).toMatchObject({
      status: 'active',
      plan: 'team',
      planPrice: 'monthly',
      quantity: 3,
    });
    expect(current.features).toEqual(['ai', 'projects']);
    expect(await env.payments.billing.hasFeature(env.ctx, 'ai')).toBe(true);
    expect(env.emitted(PaymentEventName.SubscriptionStarted)).toEqual([
      expect.objectContaining({
        payee: 'platform',
        billingOwnerType: 'tenant',
        billingOwnerId: 'tenant-a',
        plan: 'team',
      }),
    ]);
    expect(env.emitted(PaymentEventName.EntitlementsUpdated)).toEqual([
      expect.objectContaining({ added: ['ai', 'projects'], removed: [] }),
    ]);
  });

  it('refuses a second subscription, unknown plans, and seats on flat plans', async () => {
    const env = billingEnv();
    await subscribed(env);
    const again = await env.tryRun('subscribeToPlan', { plan: 'team', price: 'monthly' });
    expect(again.success ? null : again.error.metadata?.reason).toBe('payments_already_subscribed');
    const unknown = await env.tryRun('subscribeToPlan', { plan: 'gold', price: 'monthly' });
    expect(unknown.success).toBe(false);
    const seats = await env.tryRun('changePlan', {
      plan: 'starter',
      price: 'monthly',
      quantity: 2,
    });
    expect(seats.success ? null : seats.error.metadata?.reason).toBe('payments_plan_not_per_seat');
  });

  it('changes plan: swaps the plan item, adds the new plan meters, updates features', async () => {
    const env = billingEnv();
    const { sub } = await subscribed(env);
    const { subscription } = await env.run<any>('changePlan', {
      plan: 'team',
      price: 'monthly',
      quantity: 2,
    });
    expect(subscription).toMatchObject({ plan: 'team', planPrice: 'monthly', quantity: 2 });
    const items = env.fake.subscriptions.get(sub.id)?.items ?? [];
    expect(items.map((item) => item.lookupKey).sort()).toEqual([
      'plumbus:myapp:meter:aiTokens',
      'plumbus:myapp:team:monthly',
    ]);
    await env.deliver('entitlements', sub.customerId);
    expect(await env.payments.billing.features(env.ctx)).toEqual(['ai', 'projects']);
    expect(env.emitted(PaymentEventName.SubscriptionUpdated)).toEqual([
      expect.objectContaining({ plan: 'team', quantity: 2 }),
    ]);

    // And back: the meter goes with the team plan.
    await env.run('changePlan', { plan: 'starter', price: 'monthly' });
    const after = env.fake.subscriptions.get(sub.id)?.items ?? [];
    expect(after.map((item) => item.lookupKey)).toEqual(['plumbus:myapp:starter:monthly']);
  });

  it('sets seats server-side on per-seat plans', async () => {
    const env = billingEnv();
    await subscribed(env, 'team', 2);
    const row = await env.payments.billing.setSeats(env.ctx, { quantity: 5 });
    expect(row.quantity).toBe(5);
    const flat = billingEnv();
    await subscribed(flat, 'starter');
    await expect(flat.payments.billing.setSeats(flat.ctx, { quantity: 2 })).rejects.toMatchObject({
      metadata: { reason: 'payments_plan_not_per_seat' },
    });
  });

  it('cancels at the end of the period, resumes, and clears features when it ends', async () => {
    const env = billingEnv();
    const { sub } = await subscribed(env);
    const later = await env.run<any>('cancelPlanSubscription', {});
    expect(later.subscription.cancelAtPeriodEnd).toBe(true);
    const resumed = await env.run<any>('resumePlanSubscription', {});
    expect(resumed.subscription.cancelAtPeriodEnd).toBe(false);
    const ended = await env.run<any>('cancelPlanSubscription', { atPeriodEnd: false });
    expect(ended.subscription.status).toBe('canceled');
    await env.deliver('entitlements', sub.customerId);
    expect(await env.payments.billing.hasFeature(env.ctx, 'projects')).toBe(false);
    expect(env.emitted(PaymentEventName.SubscriptionEnded)).toHaveLength(1);
  });

  it('opens the billing portal once a customer exists', async () => {
    const env = billingEnv();
    const none = await env.tryRun('openBillingPortal', {});
    expect(none.success ? null : none.error.metadata?.reason).toBe('payments_no_billing_customer');
    await subscribed(env);
    const { url } = await env.run<any>('openBillingPortal', {});
    expect(url).toMatch(/^https:\/\/portal\.fake\.test\//);
  });

  it('keeps members without the billing role out of plan changes but lets them read features', async () => {
    const env = billingEnv();
    await subscribed(env);
    const member = withAuth(env.ctx, {
      userId: 'member-1',
      tenantId: 'tenant-a',
      roles: ['member'],
      scopes: [],
      provider: 'test',
    });
    expect((await env.tryRun('cancelPlanSubscription', {}, member)).success).toBe(false);
    expect((await env.run<any>('getEntitlements', {}, member)).features).toEqual(['projects']);
  });
});

describe('usage and purchases', () => {
  it('records usage on a meter once per identifier', async () => {
    const env = billingEnv();
    await subscribed(env, 'team', 1);
    await env.payments.billing.recordUsage(env.ctx, {
      meter: 'aiTokens',
      value: 1200,
      identifier: 'call-1',
    });
    await env.payments.billing.recordUsage(env.ctx, {
      meter: 'aiTokens',
      value: 1200,
      identifier: 'call-1',
    });
    expect(env.fake.usage).toEqual([
      expect.objectContaining({ eventName: 'ai_tokens', value: 1200, identifier: 'call-1' }),
    ]);
    await expect(
      env.payments.billing.recordUsage(env.ctx, { meter: 'nope', value: 1 }),
    ).rejects.toMatchObject({ metadata: { reason: 'payments_unknown_meter' } });
  });

  it('refuses usage for a customer that never subscribed', async () => {
    const env = billingEnv();
    await expect(
      env.payments.billing.recordUsage(env.ctx, { meter: 'aiTokens', value: 5 }),
    ).rejects.toMatchObject({ metadata: { reason: 'payments_no_billing_customer' } });
  });

  it('meters AI calls through the onAICostRecorded bridge', async () => {
    const env = billingEnv();
    await subscribed(env, 'team', 1);
    const customer = (await env.data.PaymentBillingCustomer.findMany({}))[0];
    const hook = env.payments.billing.aiUsageBridge({ meter: 'aiTokens', value: 'tokens' });
    const queries: unknown[] = [];
    const db = {
      async execute(query: unknown) {
        queries.push(query);
        return [{ provider_customer_id: customer.providerCustomerId }];
      },
    };
    const record = {
      id: 'ai-1',
      timestamp: new Date(),
      model: 'm',
      provider: 'p',
      operation: 'generate',
      usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 },
      cost: 0.01,
      latencyMs: 5,
      tenantId: 'tenant-a',
      status: 'success',
    } as AICostRecord;
    await hook(record, undefined, db);
    expect(queries).toHaveLength(1);
    expect(env.fake.usage).toEqual([
      expect.objectContaining({
        value: 1000,
        identifier: 'plumbus-ai:ai-1',
        eventName: 'ai_tokens',
      }),
    ]);
    // No tenant: nothing to bill.
    await hook({ ...record, id: 'ai-2', tenantId: undefined }, undefined, db);
    expect(env.fake.usage).toHaveLength(1);
  });

  it('sells one-off purchases billed to the caller’s billing customer', async () => {
    const env = billingEnv();
    const { charge } = await env.payments.billing.purchase(env.ctx, {
      description: '1,000 credits',
      currency: 'usd',
      amount: 1000,
      email: 'owner@acme.test',
    });
    const customer = (await env.data.PaymentBillingCustomer.findMany({}))[0];
    expect(charge).toMatchObject({ flow: 'platform', billingCustomerId: customer.id });
    const input = [...env.fake.calls].reverse().find((c) => c.method === 'createCharge')
      ?.input as any;
    expect(input).toMatchObject({ flow: 'platform', clientId: customer.providerCustomerId });

    const page = [...env.fake.charges.values()][0];
    if (!page) throw new Error('no page');
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    expect(env.emitted(PaymentEventName.ChargePaid)).toEqual([
      expect.objectContaining({ billingCustomerId: customer.id, flow: 'platform' }),
    ]);
  });
});

describe('billing customers', () => {
  it('bills each seller for their own subscription', async () => {
    const env = await onboardedSeller({
      billing: { ...plans, customer: 'seller' },
      appId: 'myapp',
    });
    await env.payments.syncCatalog();
    const { subscription } = await env.run<any>('subscribeToPlan', {
      plan: 'starter',
      price: 'monthly',
    });
    const merchant = (await env.run<any>('getMerchantAccount', {})).merchantAccount;
    const customer = (await (env.ctx.data as any).PaymentBillingCustomer.findMany({}))[0];
    expect(customer).toMatchObject({ ownerType: 'seller', ownerId: merchant.id });
    expect(subscription.billingCustomerId).toBe(customer.id);
  });

  it('bills each signed-in user, who may manage their own plan', async () => {
    const env = billingEnv({ billing: { ...plans, customer: 'user' }, access: {} });
    await env.payments.syncCatalog();
    await env.run('subscribeToPlan', { plan: 'starter', price: 'monthly' });
    const customer = (await env.data.PaymentBillingCustomer.findMany({}))[0];
    expect(customer).toMatchObject({ ownerType: 'user', ownerId: 'admin-1' });
  });
});
