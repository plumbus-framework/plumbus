// Subscriptions sellers sell to their clients: checkout, renewals, failed
// payments, cancel and resume, and a checkout that never completes.

import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { deliverTestWebhook } from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { onboardedSeller } from './helpers.js';

async function seller(overrides: Partial<PaymentsConfig> = {}) {
  const env = await onboardedSeller({
    platformFee: { percent: 7.5 },
    subscriptions: { enabled: true },
    ...overrides,
  });
  const data = env.ctx.data as any;
  const deliver = (type: Parameters<typeof env.fake.event>[0], id: string) =>
    deliverTestWebhook(env.payments, env.ctx, env.fake.event(type, id));
  const lastInput = (method: string) =>
    [...env.fake.calls].reverse().find((c) => c.method === method)?.input as any;
  return { ...env, data, deliver, lastInput };
}

const plan = {
  client: { reference: 'student-1', email: 'parent@example.com' },
  currency: 'usd',
  items: [{ name: 'Weekly tutoring', unitAmount: 8000, interval: 'month' as const }],
};

async function started(env: Awaited<ReturnType<typeof seller>>, input: object = {}) {
  const { subscription } = await env.run<any>('createSubscription', { ...plan, ...input });
  const checkout = [...env.fake.subscriptionCheckouts.values()].at(-1);
  if (!checkout) throw new Error('no checkout');
  const sub = env.fake.completeSubscriptionCheckout(checkout.id);
  await env.deliver('subscription_checkout', checkout.id);
  return { subscription, checkout, sub };
}

describe('seller subscriptions', () => {
  it('opens a subscription checkout with the platform percentage and starts it on completion', async () => {
    const env = await seller();
    const { subscription } = await env.run<any>('createSubscription', { ...plan, trialDays: 7 });
    expect(subscription).toMatchObject({ status: 'incomplete', payee: 'seller' });
    expect(subscription.checkoutUrl).toMatch(/^https:\/\/pay\.fake\.test\/cs_sub_fake/);
    expect(env.lastInput('createSubscriptionCheckout')).toMatchObject({
      flow: 'direct',
      sellerAccountId: env.accountId,
      applicationFeePercent: 7.5,
      trialDays: 7,
      items: [
        {
          inline: {
            name: 'Weekly tutoring',
            unitAmount: 8000,
            interval: 'month',
            intervalCount: 1,
          },
          quantity: 1,
        },
      ],
    });

    const checkout = [...env.fake.subscriptionCheckouts.values()][0];
    if (!checkout) throw new Error('no checkout');
    env.fake.completeSubscriptionCheckout(checkout.id);
    await env.deliver('subscription_checkout', checkout.id);

    const { subscription: live } = await env.run<any>('getSubscription', {
      subscriptionId: subscription.id,
    });
    expect(live).toMatchObject({ status: 'trialing', checkoutUrl: null });
    expect(env.emitted(PaymentEventName.SubscriptionStarted)).toEqual([
      expect.objectContaining({
        subscriptionId: subscription.id,
        payee: 'seller',
        status: 'trialing',
      }),
    ]);
  });

  it('records renewal invoices and a failed payment', async () => {
    const env = await seller();
    const { subscription, sub } = await started(env);
    const invoice = env.fake.renewSubscription(sub.id, { paid: true });
    await env.deliver('invoice', invoice.id);
    expect(env.emitted(PaymentEventName.InvoicePaid)).toHaveLength(1);

    const failed = env.fake.renewSubscription(sub.id, { paid: false });
    await env.deliver('invoice', failed.id);
    expect(env.emitted(PaymentEventName.InvoicePaymentFailed)).toEqual([
      expect.objectContaining({ subscriptionId: subscription.id, amountPaid: 0 }),
    ]);
    const { subscription: pastDue, invoices } = await env.run<any>('getSubscription', {
      subscriptionId: subscription.id,
    });
    expect(pastDue.status).toBe('past_due');
    expect(invoices.map((i: any) => i.status).sort()).toEqual(['open', 'paid']);
    expect(env.emitted(PaymentEventName.SubscriptionUpdated)).toEqual([
      expect.objectContaining({ status: 'past_due', previousStatus: 'active' }),
    ]);
  });

  it('cancels at the end of the period, resumes, then cancels now', async () => {
    const env = await seller();
    const { subscription } = await started(env);
    const later = await env.run<any>('cancelSubscription', { subscriptionId: subscription.id });
    expect(later.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    const resumed = await env.run<any>('resumeSubscription', { subscriptionId: subscription.id });
    expect(resumed.subscription.cancelAtPeriodEnd).toBe(false);
    const now = await env.run<any>('cancelSubscription', {
      subscriptionId: subscription.id,
      atPeriodEnd: false,
    });
    expect(now.subscription.status).toBe('canceled');
    expect(env.emitted(PaymentEventName.SubscriptionUpdated)).toHaveLength(2);
    expect(env.emitted(PaymentEventName.SubscriptionEnded)).toHaveLength(1);
  });

  it('cancels at the end of the period again after a resume (each cancel is a new request)', async () => {
    const env = await seller();
    const { subscription, sub } = await started(env);
    await env.run('cancelSubscription', { subscriptionId: subscription.id });
    await env.run('resumeSubscription', { subscriptionId: subscription.id });
    const again = await env.run<any>('cancelSubscription', { subscriptionId: subscription.id });
    expect(again.subscription.cancelAtPeriodEnd).toBe(true);
    expect(env.fake.subscriptions.get(sub.id)?.cancelAtPeriodEnd).toBe(true);
  });

  it('ends a subscription whose checkout expires, and withdraws one on cancel', async () => {
    const env = await seller();
    const { subscription } = await env.run<any>('createSubscription', plan);
    const checkout = [...env.fake.subscriptionCheckouts.values()][0];
    if (!checkout) throw new Error('no checkout');
    env.fake.expireSubscriptionCheckout(checkout.id);
    await env.deliver('subscription_checkout', checkout.id);
    const { subscription: expired } = await env.run<any>('getSubscription', {
      subscriptionId: subscription.id,
    });
    expect(expired.status).toBe('incomplete_expired');
    expect(env.emitted(PaymentEventName.SubscriptionEnded)).toHaveLength(1);

    const second = await env.run<any>('createSubscription', {
      ...plan,
      client: { reference: 'student-2' },
    });
    const withdrawn = await env.run<any>('cancelSubscription', {
      subscriptionId: second.subscription.id,
    });
    expect(withdrawn.subscription.status).toBe('incomplete_expired');
    expect(env.lastInput('cancelCharge')).toMatchObject({ collection: 'checkout' });
    expect(env.emitted(PaymentEventName.SubscriptionEnded)).toHaveLength(2);
  });

  it('lists subscriptions and keeps other sellers out', async () => {
    const env = await seller();
    const { subscription } = await started(env);
    const { subscriptions } = await env.run<any>('listSubscriptions', { status: 'active' });
    expect(subscriptions.map((s: any) => s.id)).toEqual([subscription.id]);
    const stranger = await env.tryRun(
      'getSubscription',
      { subscriptionId: subscription.id },
      env.as('seller-2'),
    );
    expect(stranger.success).toBe(false);
  });

  it('are off unless subscriptions.enabled', async () => {
    const env = await onboardedSeller();
    expect(env.payments.capabilities.createSubscription).toBeUndefined();
  });

  it('refuse a fee percentage with more than two decimals', async () => {
    await expect(
      onboardedSeller({ subscriptions: { enabled: true, platformFeePercent: 2.555 } }),
    ).rejects.toThrow('at most two decimals');
  });
});
