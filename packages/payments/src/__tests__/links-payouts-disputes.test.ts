// Reusable payment links, seller payouts, and answering disputes.

import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { deliverTestWebhook } from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { onboardedSeller } from './helpers.js';

async function seller(overrides: Partial<PaymentsConfig> = {}) {
  const env = await onboardedSeller({ platformFee: { percent: 10 }, ...overrides });
  const data = env.ctx.data as any;
  const deliver = (type: Parameters<typeof env.fake.event>[0], id: string) =>
    deliverTestWebhook(env.payments, env.ctx, env.fake.event(type, id));
  const lastInput = (method: string) =>
    [...env.fake.calls].reverse().find((c) => c.method === method)?.input as any;
  return { ...env, data, deliver, lastInput };
}

describe('payment links', () => {
  it('creates a reusable link; every payment through it becomes its own charge', async () => {
    const env = await seller();
    const { link } = await env.run<any>('createPaymentLink', {
      description: 'Group class',
      currency: 'usd',
      items: [
        { name: 'Group class', unitAmount: 1500, adjustableQuantity: { minimum: 1, maximum: 5 } },
      ],
      metadata: { classId: 'c-1' },
    });
    expect(link).toMatchObject({ active: true, platformFeeAmount: 150 });
    expect(link.url).toMatch(/^https:\/\/buy\.fake\.test\//);
    expect(env.lastInput('createPaymentLink')).toMatchObject({
      flow: 'direct',
      sellerAccountId: env.accountId,
      completedUrl: 'https://app.test/thanks',
      items: [expect.objectContaining({ adjustableQuantity: { minimum: 1, maximum: 5 } })],
    });

    const providerLink = [...env.fake.links.values()][0];
    if (!providerLink) throw new Error('no link');
    const first = env.fake.payLink(providerLink.id, { quantity: 3 });
    const second = env.fake.payLink(providerLink.id);
    await env.deliver('charge', first.id);
    await env.deliver('charge', second.id);
    await env.deliver('charge', first.id);

    const { charges } = await env.run<any>('listCharges', { collection: 'link' });
    expect(charges.map((c: any) => c.amount).sort()).toEqual([1500, 4500]);
    expect(charges.every((c: any) => c.linkId === link.id && c.status === 'paid')).toBe(true);
    expect(env.emitted(PaymentEventName.ChargeCreated)).toHaveLength(2);
    expect(env.emitted(PaymentEventName.ChargePaid)).toEqual([
      expect.objectContaining({ linkId: link.id, amount: 4500 }),
      expect.objectContaining({ linkId: link.id, amount: 1500 }),
    ]);
    expect(charges[0].metadata).toEqual({ classId: 'c-1' });
  });

  it('turns a link off and on', async () => {
    const env = await seller();
    const { link } = await env.run<any>('createPaymentLink', {
      description: 'Donation',
      currency: 'usd',
      customAmount: { minimum: 500 },
    });
    const off = await env.run<any>('setPaymentLinkActive', { linkId: link.id, active: false });
    expect(off.link).toMatchObject({ active: false, url: null });
    const on = await env.run<any>('setPaymentLinkActive', { linkId: link.id, active: true });
    expect(on.link.active).toBe(true);
    const { links } = await env.run<any>('listPaymentLinks', {});
    expect(links).toHaveLength(1);
  });

  it("ignores a link payment made on another seller's account", async () => {
    const env = await seller();
    await env.run<any>('createPaymentLink', {
      description: 'Class',
      currency: 'usd',
      amount: 1500,
    });
    // A second seller in the same tenant, with an account of their own.
    const other = env.as('seller-2');
    await env.run('startMerchantOnboarding', {}, other);
    const otherAccount = [...env.fake.accounts.keys()].find((id) => id !== env.accountId) as string;

    const providerLink = [...env.fake.links.values()][0];
    if (!providerLink) throw new Error('no link');
    const paid = env.fake.payLink(providerLink.id);
    paid.accountId = otherAccount;
    const result = await env.deliver('charge', paid.id);
    expect(result.status).toBe('received');
    expect(result.processed).toMatchObject({ status: 'processed' });
    expect((await env.run<any>('listCharges', {})).charges).toHaveLength(0);
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(0);
  });
});

describe('payouts', () => {
  it('records payouts from webhooks and announces paid and failed ones', async () => {
    const env = await seller();
    const payout = env.fake.payoutSeller(env.accountId, { amount: 9000 });
    await env.deliver('payout', payout.id);
    env.fake.setPayoutStatus(payout.id, 'paid');
    await env.deliver('payout', payout.id);
    const failing = env.fake.payoutSeller(env.accountId, { amount: 500, status: 'failed' });
    await env.deliver('payout', failing.id);

    const { payouts } = await env.run<any>('listPayouts', {});
    expect(payouts.map((p: any) => [p.amount, p.status]).sort()).toEqual([
      [500, 'failed'],
      [9000, 'paid'],
    ]);
    expect(env.emitted(PaymentEventName.PayoutPaid)).toEqual([
      expect.objectContaining({ amount: 9000, ownerId: 'seller-1' }),
    ]);
    expect(env.emitted(PaymentEventName.PayoutFailed)).toEqual([
      expect.objectContaining({ amount: 500, failureCode: 'account_closed' }),
    ]);
  });

  it('sets the app schedule for new Express sellers', async () => {
    const env = await seller({
      dashboards: { express: true },
      payouts: { schedule: { interval: 'weekly', weeklyAnchor: 'friday' } },
    });
    expect(env.lastInput('updatePayoutSchedule')).toMatchObject({
      accountId: env.accountId,
      schedule: { interval: 'weekly', weeklyAnchor: 'friday' },
    });
    const { settings } = await env.run<any>('getPayoutSettings', {});
    expect(settings).toMatchObject({
      schedule: { interval: 'weekly', weeklyAnchor: 'friday' },
      canChangeSchedule: false,
      instantAvailable: false,
    });
    expect(env.payments.capabilities.updatePayoutSchedule).toBeUndefined();
  });

  it('lets Express sellers change their schedule and take instant payouts when allowed', async () => {
    const env = await seller({
      dashboards: { express: true },
      payouts: { sellersMayChangeSchedule: true, instant: true },
    });
    const changed = await env.run<any>('updatePayoutSchedule', {
      schedule: { interval: 'monthly', monthlyAnchor: 15 },
    });
    expect(changed.settings.schedule).toEqual({ interval: 'monthly', monthlyAnchor: 15 });
    const { payout } = await env.run<any>('createInstantPayout', {
      amount: 2500,
      currency: 'usd',
      requestId: 'now-1',
    });
    expect(payout).toMatchObject({ amount: 2500, method: 'instant', status: 'pending' });
    // The payout's webhook updates the same row.
    const providerPayout = [...env.fake.payouts.values()][0];
    if (!providerPayout) throw new Error('no payout');
    env.fake.setPayoutStatus(providerPayout.id, 'paid');
    await env.deliver('payout', providerPayout.id);
    expect((await env.run<any>('listPayouts', {})).payouts).toEqual([
      expect.objectContaining({ id: payout.id, status: 'paid' }),
    ]);
  });

  it('leaves full-dashboard sellers to manage their own payouts', async () => {
    const env = await seller({ payouts: { sellersMayChangeSchedule: true } });
    const result = await env.tryRun('updatePayoutSchedule', { schedule: { interval: 'daily' } });
    expect(result.success ? null : result.error.metadata?.reason).toBe(
      'payments_payouts_managed_by_seller',
    );
  });
});

describe('disputes', () => {
  async function disputed() {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 5000,
      currency: 'usd',
      description: 'Lesson',
    });
    const page = [...env.fake.charges.values()][0];
    if (!page) throw new Error('no page');
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    const providerDispute = env.fake.openDispute(page.id);
    await env.deliver('dispute', providerDispute.id);
    const [dispute] = (await env.run<any>('listDisputes', {})).disputes;
    return { env, charge, dispute, providerDispute };
  }

  it('submits evidence once; afterwards the dispute takes no more answers', async () => {
    const { env, charge, dispute } = await disputed();
    expect(dispute).toMatchObject({ chargeId: charge.id, status: 'needs_response' });
    const { dispute: answered } = await env.run<any>('respondToDispute', {
      disputeId: dispute.id,
      evidence: { productDescription: 'A 1h lesson', serviceDate: '2026-09-01' },
      submit: true,
    });
    expect(answered).toMatchObject({ status: 'under_review', evidenceSubmitted: true });
    expect(env.lastInput('updateDispute')).toMatchObject({
      sellerAccountId: env.accountId,
      submit: true,
    });
    const again = await env.tryRun('acceptDispute', { disputeId: dispute.id });
    expect(again.success ? null : again.error.metadata?.reason).toBe('payments_dispute_closed');
  });

  it('accepts a dispute', async () => {
    const { env, dispute } = await disputed();
    const { dispute: accepted } = await env.run<any>('acceptDispute', { disputeId: dispute.id });
    expect(accepted.status).toBe('lost');
  });
});
