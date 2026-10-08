// Money flows: destination charges (the platform charges, the seller is paid at
// once), platform charges the app keeps or transfers later, and webhooks from
// the platform account finding their tenant.

import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { deliverTestWebhook } from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { onboardedSeller, setup } from './helpers.js';

function only<T>(map: Map<string, T>): T {
  const values = [...map.values()];
  if (values.length !== 1) throw new Error(`expected one entry, found ${values.length}`);
  return values[0] as T;
}

async function destinationSeller(overrides: Partial<PaymentsConfig> = {}) {
  const env = await onboardedSeller({
    dashboards: { express: true },
    platformFee: { percent: 10 },
    ...overrides,
  });
  const data = env.ctx.data as any;
  const deliver = (type: Parameters<typeof env.fake.event>[0], id: string) =>
    deliverTestWebhook(env.payments, env.ctx, env.fake.event(type, id));
  return { ...env, data, deliver };
}

describe('destination charges', () => {
  it('asks the provider for transfers and turns the seller active when transfers are on', async () => {
    const env = setup({ dashboards: { express: true } });
    const { merchantAccount } = await env.run<any>('startMerchantOnboarding', {});
    expect(merchantAccount).toMatchObject({ chargeType: 'destination', status: 'onboarding' });
    const input = env.fake.calls.find((c) => c.method === 'createMerchantAccount')?.input as any;
    expect(input.capabilities).toEqual({ cardPayments: false, transfers: true });

    const accountId = env.fake.accounts.keys().next().value as string;
    env.fake.completeOnboarding(accountId);
    const synced = await env.run<any>('syncMerchantAccount', {});
    expect(synced.merchantAccount).toMatchObject({
      status: 'active',
      transfersEnabled: true,
      chargesEnabled: false,
    });
  });

  it('with onBehalfOf, needs card payments too', async () => {
    const env = setup({ dashboards: { express: true }, destination: { onBehalfOf: true } });
    await env.run('startMerchantOnboarding', {});
    const input = env.fake.calls.find((c) => c.method === 'createMerchantAccount')?.input as any;
    expect(input.capabilities).toEqual({ cardPayments: true, transfers: true });
  });

  it('charges on the platform, pays the seller, and applies the platform webhook by tenant', async () => {
    const env = await destinationSeller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 3000,
      currency: 'usd',
      description: 'Physics',
      client: { email: 'kid@example.com' },
    });
    expect(charge).toMatchObject({ flow: 'destination', platformFeeAmount: 300 });
    const input = env.fake.calls.find((c) => c.method === 'createCharge')?.input as any;
    expect(input).toMatchObject({ flow: 'destination', sellerAccountId: env.accountId });

    // The client's provider customer lives on the platform for destination charges.
    const client = await env.data.PaymentClient.findById(charge.clientId);
    expect(client.onPlatform).toBe(true);
    expect(env.fake.customers.get(client.providerClientId)?.accountId).toBeNull();

    const providerCharge = only(env.fake.charges);
    expect(providerCharge.accountId).toBeNull();
    env.fake.payCharge(providerCharge.id);
    const result = await env.deliver('charge', providerCharge.id);
    expect(result.status).toBe('received');
    expect((await env.data.PaymentCharge.findById(charge.id)).status).toBe('paid');
    expect(env.emitted(PaymentEventName.ChargePaid)).toEqual([
      expect.objectContaining({ chargeId: charge.id, flow: 'destination', ownerId: 'seller-1' }),
    ]);
  });

  it("refunds on the platform and takes the refund back from the seller's transfer", async () => {
    const env = await destinationSeller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 3000,
      currency: 'usd',
      description: 'Physics',
    });
    const providerCharge = only(env.fake.charges);
    env.fake.payCharge(providerCharge.id);
    await env.deliver('charge', providerCharge.id);

    await env.run('refundCharge', { chargeId: charge.id, amount: 1000 });
    const input = env.fake.calls.find((c) => c.method === 'createRefund')?.input as any;
    expect(input).toMatchObject({
      routing: { flow: 'destination', sellerAccountId: env.accountId },
      reverseTransfer: true,
    });
  });

  it("ignores a seller's own payment that claims a destination charge", async () => {
    const env = await destinationSeller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 3000,
      currency: 'usd',
      description: 'Physics',
    });
    const providerCharge = only(env.fake.charges);
    // Same reference, same amount, but made on the seller's own account.
    env.fake.charges.set('cs_seller_own', {
      ...providerCharge,
      id: 'cs_seller_own',
      accountId: env.accountId,
      status: 'paid',
      paymentId: 'pi_seller_own',
      paidAt: new Date(),
    });
    await env.deliver('charge', 'cs_seller_own');
    expect((await env.data.PaymentCharge.findById(charge.id)).status).toBe('open');
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(0);
  });

  it('refuses charges while the seller cannot receive transfers', async () => {
    const env = setup({ dashboards: { express: true } });
    await env.run('startMerchantOnboarding', {});
    const result = await env.tryRun('createCharge', {
      amount: 1000,
      currency: 'usd',
      description: 'Too early',
    });
    expect(result.success).toBe(false);
  });
});

describe('platform charges and transfers', () => {
  async function marketplace() {
    const env = await destinationSeller({ transfers: { enabled: true } });
    return env;
  }

  it('charges a client on the platform, then sends part of it to the seller', async () => {
    const env = await marketplace();
    const { charge } = await env.payments.platform.createCharge(env.ctx, {
      description: 'Cart',
      currency: 'usd',
      items: [
        { name: 'Guitar lesson', unitAmount: 4000, quantity: 1 },
        { name: 'Sheet music', unitAmount: 1000, quantity: 2 },
      ],
      client: { email: 'buyer@example.com' },
      transferGroup: 'order-7',
    });
    expect(charge).toMatchObject({ flow: 'platform', amount: 6000, merchantAccountId: null });
    const providerCharge = only(env.fake.charges);
    expect(providerCharge.accountId).toBeNull();

    env.fake.payCharge(providerCharge.id);
    const delivered = await env.deliver('charge', providerCharge.id);
    expect(delivered.status).toBe('received');
    expect((await env.data.PaymentCharge.findById(charge.id)).status).toBe('paid');

    const merchant = (await env.run<any>('getMerchantAccount', {})).merchantAccount;
    const { transfer } = await env.payments.platform.transferToSeller(env.ctx, {
      merchantAccountId: merchant.id,
      chargeId: charge.id,
      amount: 4500,
      currency: 'usd',
      requestId: 'order-7-seller-1',
    });
    expect(transfer).toMatchObject({ amount: 4500, chargeId: charge.id, transferGroup: 'order-7' });
    const sent = only(env.fake.transfers);
    expect(sent).toMatchObject({
      destinationAccountId: env.accountId,
      sourcePaymentId: providerCharge.paymentId,
    });
    expect(env.emitted(PaymentEventName.TransferCreated)).toHaveLength(1);

    // The same requestId returns the same transfer.
    const again = await env.payments.platform.transferToSeller(env.ctx, {
      merchantAccountId: merchant.id,
      chargeId: charge.id,
      amount: 4500,
      currency: 'usd',
      requestId: 'order-7-seller-1',
    });
    expect(again.created).toBe(false);

    await expect(
      env.payments.platform.transferToSeller(env.ctx, {
        merchantAccountId: merchant.id,
        chargeId: charge.id,
        amount: 2000,
        currency: 'usd',
      }),
    ).rejects.toMatchObject({ metadata: { reason: 'payments_transfer_exceeds_charge' } });

    const reversed = await env.payments.platform.reverseTransfer(env.ctx, {
      transferId: transfer.id,
      amount: 500,
    });
    expect(reversed.transfer.amountReversed).toBe(500);
    expect(env.emitted(PaymentEventName.TransferReversed)).toHaveLength(1);

    const listed = await env.run<any>('listTransfers', {});
    expect(listed.transfers).toHaveLength(1);
  });

  it('refuses transfers unless transfers are enabled', async () => {
    const env = await destinationSeller();
    const merchant = (await env.run<any>('getMerchantAccount', {})).merchantAccount;
    await expect(
      env.payments.platform.transferToSeller(env.ctx, {
        merchantAccountId: merchant.id,
        amount: 100,
        currency: 'usd',
      }),
    ).rejects.toMatchObject({ metadata: { reason: 'payments_transfers_disabled' } });
  });

  it('a transfer reversal made at the provider reaches the app', async () => {
    const env = await marketplace();
    const merchant = (await env.run<any>('getMerchantAccount', {})).merchantAccount;
    const { transfer } = await env.payments.platform.transferToSeller(env.ctx, {
      merchantAccountId: merchant.id,
      amount: 800,
      currency: 'usd',
    });
    const sent = only(env.fake.transfers);
    sent.amountReversed = 300;
    // Transfer events carry no seller account: the tenant comes from the transfer's metadata.
    const result = await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('transfer', sent.id),
    );
    expect(result.status).toBe('received');
    expect((await env.data.PaymentTransfer.findById(transfer.id)).amountReversed).toBe(300);
    expect(env.emitted(PaymentEventName.TransferReversed)).toEqual([
      expect.objectContaining({ transferId: transfer.id, amountReversed: 300 }),
    ]);
  });
});

describe('platform events find their tenant', () => {
  it('by the metadata stamped on the object, else by the local customer or payment', async () => {
    const env = await destinationSeller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 3000,
      currency: 'usd',
      description: 'Physics',
    });
    const providerCharge = only(env.fake.charges);
    expect(providerCharge.metadata.plumbus_tenant_id).toBe('tenant-a');
    env.fake.payCharge(providerCharge.id);

    // Strip the metadata: the payment id still leads to the local charge's tenant.
    providerCharge.metadata = {};
    const first = await env.deliver('charge', providerCharge.id);
    expect(first.status).toBe('ignored');
    const paymentRow = await env.data.PaymentCharge.findById(charge.id);
    await env.data.PaymentCharge.update(charge.id, {
      providerPaymentId: providerCharge.paymentId,
    });
    const second = await env.deliver('charge', providerCharge.id);
    expect(second.status).toBe('received');
    expect(paymentRow.status).toBe('open');
    expect((await env.data.PaymentCharge.findById(charge.id)).status).toBe('paid');
  });

  it('ignores platform objects that are not the app’s', async () => {
    const env = await destinationSeller();
    env.fake.charges.set('cs_other_app', {
      ...{
        id: 'cs_other_app',
        reference: null,
        paymentId: 'pi_other_app',
        linkId: null,
        status: 'paid',
        currency: 'usd',
        amountSubtotal: 100,
        amountTotal: 100,
        amountDiscount: 0,
        amountTax: 0,
        platformFeeAmount: 0,
        amountRefunded: 0,
        amountCapturable: null,
        captureBefore: null,
        url: null,
        clientSecret: null,
        expiresAt: null,
        paidAt: new Date(),
        clientEmail: null,
        customerId: null,
        savedMethod: null,
        failureCode: null,
        livemode: false,
      },
      accountId: null,
      sellerAccountId: null,
      kind: 'checkout',
      items: [],
      customAmount: null,
      capture: 'automatic',
      saveMethod: false,
      metadata: {},
    });
    const result = await env.deliver('charge', 'cs_other_app');
    expect(result).toMatchObject({ status: 'ignored', ignoredReason: 'unknown_platform_object' });
  });
});
