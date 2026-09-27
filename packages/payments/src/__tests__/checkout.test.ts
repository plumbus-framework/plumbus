// What a charge asks for and how the client pays it: line items, amounts the
// client chooses, payment page options, embedded pages, invoices, holds.

import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { deliverTestWebhook } from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { onboardedSeller, urls } from './helpers.js';

function only<T>(map: Map<string, T>): T {
  const values = [...map.values()];
  if (values.length !== 1) throw new Error(`expected one entry, found ${values.length}`);
  return values[0] as T;
}

async function seller(overrides: Partial<PaymentsConfig> = {}) {
  const env = await onboardedSeller({ platformFee: { percent: 10 }, ...overrides });
  const data = env.ctx.data as any;
  const lastInput = (method: string) =>
    [...env.fake.calls].reverse().find((c) => c.method === method)?.input as any;
  const deliver = (type: Parameters<typeof env.fake.event>[0], id: string) =>
    deliverTestWebhook(env.payments, env.ctx, env.fake.event(type, id));
  return { ...env, data, lastInput, deliver };
}

describe('what a charge asks for', () => {
  it('bills line items and computes the fee on their total', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      description: 'Term',
      currency: 'usd',
      items: [
        { name: 'Lesson', unitAmount: 2500, quantity: 4 },
        { name: 'Workbook', description: 'Printed', unitAmount: 1500 },
      ],
    });
    expect(charge).toMatchObject({ amount: 11_500, platformFeeAmount: 1150 });
    expect(charge.items).toEqual([
      { name: 'Lesson', description: null, unitAmount: 2500, quantity: 4 },
      { name: 'Workbook', description: 'Printed', unitAmount: 1500, quantity: 1 },
    ]);
    expect(env.lastInput('createCharge').items).toHaveLength(2);
  });

  it('refuses both an amount and items, or neither', async () => {
    const env = await seller();
    const both = await env.tryRun('createCharge', {
      description: 'x',
      currency: 'usd',
      amount: 100,
      items: [{ name: 'y', unitAmount: 100 }],
    });
    const neither = await env.tryRun('createCharge', { description: 'x', currency: 'usd' });
    expect([both.success, neither.success]).toEqual([false, false]);
  });

  it('lets the client choose the amount; the paid amount becomes the charge amount', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      description: 'Tip your tutor',
      currency: 'usd',
      customAmount: { minimum: 500, preset: 1500, maximum: 10_000 },
    });
    // The fee is fixed when the page opens: it is computed on the minimum.
    expect(charge).toMatchObject({ customAmount: true, amount: 1500, platformFeeAmount: 50 });
    expect(env.lastInput('createCharge').customAmount).toEqual({
      minimum: 500,
      preset: 1500,
      maximum: 10_000,
    });

    const page = only(env.fake.charges);
    env.fake.payCharge(page.id, { amount: 4200 });
    await env.deliver('charge', page.id);
    expect(await env.data.PaymentCharge.findById(charge.id)).toMatchObject({
      status: 'paid',
      amount: 4200,
      amountTotal: 4200,
    });
  });

  it('sends the app metadata and page options, over the config defaults', async () => {
    const env = await seller({
      checkout: { locale: 'fr', allowPromotionCodes: true, billingAddress: 'required' },
    });
    await env.run('createCharge', {
      amount: 2000,
      currency: 'usd',
      description: 'Lesson',
      metadata: { lessonId: 'l-9' },
      options: {
        phone: true,
        shippingCountries: ['US'],
        submitType: 'book',
        statementDescriptorSuffix: 'LESSON 9',
        allowPromotionCodes: false,
      },
    });
    const input = env.lastInput('createCharge');
    expect(input.options).toEqual({
      allowPromotionCodes: false,
      automaticTax: false,
      phone: true,
      billingAddress: 'required',
      shippingCountries: ['US'],
      locale: 'fr',
      submitType: 'book',
      statementDescriptorSuffix: 'LESSON 9',
    });
    expect(input.metadata).toMatchObject({ lessonId: 'l-9', plumbus_tenant_id: 'tenant-a' });
  });

  it('records discounts and tax, and refunds up to what was paid', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 10_000,
      currency: 'usd',
      description: 'Lesson pack',
    });
    const page = only(env.fake.charges);
    env.fake.payCharge(page.id, { discount: 2000, tax: 640 });
    await env.deliver('charge', page.id);
    const stored = await env.run<any>('getCharge', { chargeId: charge.id });
    expect(stored.charge).toMatchObject({
      amount: 10_000,
      amountDiscount: 2000,
      amountTax: 640,
      amountTotal: 8640,
    });
    const tooMuch = await env.tryRun('refundCharge', { chargeId: charge.id, amount: 9000 });
    expect(tooMuch.success).toBe(false);
    const all = await env.run<any>('refundCharge', { chargeId: charge.id });
    expect(all.refund.amount).toBe(8640);
    expect(env.emitted(PaymentEventName.ChargePaid)[0]).toMatchObject({ amountTotal: 8640 });
  });
});

describe('embedded payment pages', () => {
  it('returns what the front end mounts instead of a link', async () => {
    const env = await seller({ checkout: { ui: 'embedded' } });
    const { charge } = await env.run<any>('createCharge', {
      amount: 2000,
      currency: 'usd',
      description: 'Lesson',
    });
    expect(charge.url).toBeNull();
    expect(charge.checkout).toEqual({
      clientSecret: expect.stringContaining('_secret'),
      publishableKey: 'pk_fake',
      accountId: env.accountId,
    });
    expect(env.lastInput('createCharge')).toMatchObject({
      ui: 'embedded',
      returnUrl: `https://app.test/returned/${charge.id}`,
    });
  });

  it('needs urls.checkoutReturn', async () => {
    const { checkoutReturn: _missing, ...withoutReturn } = urls;
    const env = await seller({ urls: withoutReturn });
    const result = await env.tryRun('createCharge', {
      amount: 2000,
      currency: 'usd',
      description: 'Lesson',
      ui: 'embedded',
    });
    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.metadata?.reason).toBe('payments_url_missing');
  });
});

describe('invoices', () => {
  it('emails an invoice, follows it to paid, and voids an unpaid one', async () => {
    const env = await seller({ invoices: { daysUntilDue: 14 } });
    const { charge } = await env.run<any>('createCharge', {
      amount: 12_000,
      currency: 'usd',
      description: 'Term fees',
      collection: 'invoice',
      client: { email: 'parent@example.com', name: 'Pat' },
    });
    expect(charge).toMatchObject({ collection: 'invoice', status: 'open' });
    expect(charge.url).toMatch(/^https:\/\/invoice\.fake\.test\//);
    expect(env.lastInput('createInvoiceCharge')).toMatchObject({
      dueInDays: 14,
      platformFeeAmount: 1200,
    });

    const invoice = only(env.fake.charges);
    env.fake.payCharge(invoice.id);
    await env.deliver('charge', invoice.id);
    expect((await env.data.PaymentCharge.findById(charge.id)).status).toBe('paid');

    const second = await env.run<any>('createCharge', {
      amount: 5000,
      currency: 'usd',
      description: 'Late fee',
      collection: 'invoice',
      client: { email: 'parent@example.com' },
    });
    const canceled = await env.run<any>('cancelCharge', { chargeId: second.charge.id });
    expect(canceled.charge.status).toBe('canceled');
    expect(env.emitted(PaymentEventName.ChargeCanceled)).toHaveLength(1);
  });

  it('needs a client and takes no page options', async () => {
    const env = await seller();
    const noClient = await env.tryRun('createCharge', {
      amount: 100,
      currency: 'usd',
      description: 'x',
      collection: 'invoice',
    });
    const withHold = await env.tryRun('createCharge', {
      amount: 100,
      currency: 'usd',
      description: 'x',
      collection: 'invoice',
      capture: 'manual',
      client: { email: 'a@b.test' },
    });
    expect([noClient.success, withHold.success]).toEqual([false, false]);
  });
});

describe('holds', () => {
  it('holds the amount, captures part of it with the fee recomputed, and releases the rest', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 20_000,
      currency: 'usd',
      description: 'Deposit',
      capture: 'manual',
    });
    expect(env.lastInput('createCharge').capture).toBe('manual');
    const page = only(env.fake.charges);
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    const held = await env.data.PaymentCharge.findById(charge.id);
    expect(held).toMatchObject({ status: 'authorized', amountCapturable: 20_000 });
    expect(env.emitted(PaymentEventName.ChargeAuthorized)).toEqual([
      expect.objectContaining({ chargeId: charge.id, amountCapturable: 20_000 }),
    ]);
    const refundHeld = await env.tryRun('refundCharge', { chargeId: charge.id });
    expect(refundHeld.success).toBe(false);

    const { charge: captured } = await env.run<any>('captureCharge', {
      chargeId: charge.id,
      amount: 15_000,
    });
    expect(captured).toMatchObject({
      status: 'paid',
      amountTotal: 15_000,
      platformFeeAmount: 1500,
    });
    expect(env.lastInput('captureCharge')).toMatchObject({
      amount: 15_000,
      platformFeeAmount: 1500,
    });
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);

    // The capture's own webhook changes nothing more.
    await env.deliver('charge', page.id);
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);
  });

  it('refuses to capture more than the hold and releases a hold on cancel', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 5000,
      currency: 'usd',
      description: 'Deposit',
      capture: 'manual',
    });
    const page = only(env.fake.charges);
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    const tooMuch = await env.tryRun('captureCharge', { chargeId: charge.id, amount: 6000 });
    expect(tooMuch.success).toBe(false);
    const released = await env.run<any>('cancelCharge', { chargeId: charge.id });
    expect(released.charge.status).toBe('canceled');
    expect(env.emitted(PaymentEventName.ChargeCanceled)).toHaveLength(1);
  });
});

describe('cancelCharge', () => {
  it('expires an open payment page and refuses paid charges', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 2000,
      currency: 'usd',
      description: 'Lesson',
    });
    const expired = await env.run<any>('cancelCharge', { chargeId: charge.id });
    expect(expired.charge).toMatchObject({ status: 'expired', url: null });
    expect(env.emitted(PaymentEventName.ChargeExpired)).toHaveLength(1);

    const second = await env.run<any>('createCharge', {
      amount: 2000,
      currency: 'usd',
      description: 'Lesson 2',
    });
    const page = [...env.fake.charges.values()].find((c) => c.reference === second.charge.id);
    if (!page) throw new Error('no page');
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    const paid = await env.tryRun('cancelCharge', { chargeId: second.charge.id });
    expect(paid.success).toBe(false);
  });
});
