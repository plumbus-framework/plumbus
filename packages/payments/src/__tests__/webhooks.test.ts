import { executeCapability } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { deliverTestWebhook, withAuth } from '../testing/index.js';
import { paymentsServiceAuth } from '../runtime/ingest.js';
import { onboardedSeller, setup } from './helpers.js';

async function withOpenCharge(overrides = {}) {
  const env = await onboardedSeller(overrides);
  const { charge } = await env.run<any>('createCharge', {
    amount: 2000,
    currency: 'usd',
    description: 'Session',
  });
  const providerCharge = [...env.fake.charges.values()][0];
  if (!providerCharge) throw new Error('no provider charge');
  env.events.clear();
  const ledger = () => (env.ctx.data as any).PaymentProviderEvent.findMany({});
  const row = () => (env.ctx.data as any).PaymentCharge.findById(charge.id);
  return { ...env, charge, providerCharge, ledger, row };
}

describe('webhook ingest + processing', () => {
  it('marks a charge paid once, however often the webhook is delivered', async () => {
    const env = await withOpenCharge();
    env.fake.payCharge(env.providerCharge.id);
    const delivery = env.fake.event('charge', env.providerCharge.id, { eventId: 'evt_paid' });

    const first = await deliverTestWebhook(env.payments, env.ctx, delivery);
    expect(first).toMatchObject({
      status: 'received',
      processed: { status: 'processed', changes: 1 },
    });
    const paid = await env.row();
    expect(paid).toMatchObject({ status: 'paid', providerPaymentId: env.providerCharge.paymentId });
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect(env.emitted(PaymentEventName.ChargePaid)).toEqual([
      expect.objectContaining({
        chargeId: env.charge.id,
        merchantAccountId: paid.merchantAccountId,
        ownerType: 'user',
        ownerId: 'seller-1',
        amount: 2000,
        currency: 'usd',
      }),
    ]);

    const again = await deliverTestWebhook(env.payments, env.ctx, delivery);
    expect(again.status).toBe('duplicate');
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);

    const [entry] = await env.ledger();
    expect(entry).toMatchObject({
      providerEventId: 'evt_paid',
      status: 'processed',
      tenantId: 'tenant-a',
      merchantAccountId: paid.merchantAccountId,
      providerAccountId: env.accountId,
      payload: null,
    });
  });

  it('a later event for the same charge changes nothing (fresh read + no backwards moves)', async () => {
    const env = await withOpenCharge();
    env.fake.payCharge(env.providerCharge.id);
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);

    // A provider snapshot that looks older (open) never moves a paid charge back.
    env.fake.setChargeStatus(env.providerCharge.id, 'open');
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );
    expect((await env.row()).status).toBe('paid');
  });

  it('skips snapshots older than what is already applied', async () => {
    const env = await withOpenCharge();
    const future = new Date(env.ctx.time.now().getTime() + 60_000);
    await (env.ctx.data as any).PaymentCharge.update(env.charge.id, { syncedAt: future });
    env.fake.payCharge(env.providerCharge.id);
    const result = await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );
    expect(result.processed).toMatchObject({ status: 'processed' });
    expect((await env.row()).status).toBe('open');
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(0);
  });

  it('emits expired and failed transitions', async () => {
    const env = await withOpenCharge();
    env.fake.setChargeStatus(env.providerCharge.id, 'expired');
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );
    expect(env.emitted(PaymentEventName.ChargeExpired)).toHaveLength(1);
    expect((await env.row()).status).toBe('expired');

    const other = await withOpenCharge();
    other.fake.setChargeStatus(other.providerCharge.id, 'processing');
    await deliverTestWebhook(
      other.payments,
      other.ctx,
      other.fake.event('charge', other.providerCharge.id),
    );
    other.fake.setChargeStatus(other.providerCharge.id, 'failed');
    await deliverTestWebhook(
      other.payments,
      other.ctx,
      other.fake.event('charge', other.providerCharge.id),
    );
    expect(other.emitted(PaymentEventName.ChargeFailed)).toHaveLength(1);
  });

  it('records refunds, including ones made outside the app, and failed refunds', async () => {
    const env = await withOpenCharge();
    env.fake.payCharge(env.providerCharge.id);
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );

    const { refund } = await env.run<any>('refundCharge', { chargeId: env.charge.id, amount: 500 });
    const providerRefund = [...env.fake.refunds.values()][0];
    if (!providerRefund) throw new Error('no refund');
    env.fake.settleRefund(providerRefund.id, 'succeeded');
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('refund', providerRefund.id));

    expect((await env.row()).amountRefunded).toBe(500);
    expect(env.emitted(PaymentEventName.ChargeRefunded)).toEqual([
      expect.objectContaining({
        chargeId: env.charge.id,
        amountRefunded: 500,
        fullyRefunded: false,
      }),
    ]);
    const stored = await (env.ctx.data as any).PaymentRefund.findById(refund.id);
    expect(stored.status).toBe('succeeded');

    // A refund the seller made in their own dashboard still shows up.
    const outside = await env.fake.createRefund({
      accountId: env.accountId,
      paymentId: env.providerCharge.paymentId as string,
      reference: 'n/a',
      amount: 1500,
      refundPlatformFee: false,
      metadata: {},
      idempotencyKey: 'outside',
    });
    const outsideRecord = env.fake.refunds.get(outside.id);
    if (outsideRecord) outsideRecord.reference = null;
    env.fake.settleRefund(outside.id, 'failed', 'expired_or_canceled_card');
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('refund', outside.id));
    const all = await (env.ctx.data as any).PaymentRefund.findMany({ chargeId: env.charge.id });
    expect(all).toHaveLength(2);
    expect(env.emitted(PaymentEventName.RefundFailed)).toEqual([
      expect.objectContaining({ amount: 1500, failureReason: 'expired_or_canceled_card' }),
    ]);
  });

  it('opens, updates, and closes disputes', async () => {
    const env = await withOpenCharge();
    env.fake.payCharge(env.providerCharge.id);
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );

    const dispute = env.fake.openDispute(env.providerCharge.id, { reason: 'product_not_received' });
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('dispute', dispute.id));
    env.fake.setDisputeStatus(dispute.id, 'under_review');
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('dispute', dispute.id));
    env.fake.setDisputeStatus(dispute.id, 'won');
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('dispute', dispute.id));

    expect(env.emitted(PaymentEventName.DisputeOpened)).toEqual([
      expect.objectContaining({
        chargeId: env.charge.id,
        status: 'needs_response',
        reason: 'product_not_received',
      }),
    ]);
    expect(env.emitted(PaymentEventName.DisputeUpdated)).toHaveLength(1);
    expect(env.emitted(PaymentEventName.DisputeClosed)).toEqual([
      expect.objectContaining({ status: 'won' }),
    ]);
  });

  it('turns account events into merchant updates', async () => {
    const env = setup();
    await env.run('startMerchantOnboarding', {});
    const accountId = [...env.fake.accounts.keys()][0] as string;
    env.fake.completeOnboarding(accountId);
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('account', accountId));
    expect(env.emitted(PaymentEventName.MerchantUpdated)).toEqual([
      expect.objectContaining({
        status: 'active',
        previousStatus: 'onboarding',
        ownerId: 'seller-1',
      }),
    ]);
    env.fake.closeAccount(accountId);
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('account', accountId));
    const account = await env.run<any>('getMerchantAccount', {});
    expect(account.merchantAccount.status).toBe('closed');
  });
});

describe('webhook ingest guards', () => {
  it('rejects bad signatures', async () => {
    const env = await withOpenCharge();
    const delivery = env.fake.event('charge', env.providerCharge.id);
    delivery.headers['x-fake-signature'] = 'forged';
    expect((await deliverTestWebhook(env.payments, env.ctx, delivery)).status).toBe('rejected');
    expect(await env.ledger()).toHaveLength(0);
  });

  it('ignores events from the other mode, unknown sellers, and unhandled types', async () => {
    const env = await withOpenCharge();
    const live = env.fake.event('charge', env.providerCharge.id, { livemode: true });
    expect(await deliverTestWebhook(env.payments, env.ctx, live)).toMatchObject({
      status: 'ignored',
      ignoredReason: 'livemode_mismatch',
    });

    const known = env.fake.accounts.get(env.accountId);
    if (!known) throw new Error('no account');
    env.fake.accounts.set('acct_stranger', { ...known, id: 'acct_stranger' });
    const stranger = env.fake.event('account', 'acct_stranger');
    expect(await deliverTestWebhook(env.payments, env.ctx, stranger)).toMatchObject({
      status: 'ignored',
      ignoredReason: 'unknown_seller_account',
    });

    const payout = env.fake.event('account', env.accountId, { type: 'payout.paid' });
    expect(await deliverTestWebhook(env.payments, env.ctx, payout)).toMatchObject({
      status: 'ignored',
      ignoredReason: 'unhandled_type',
    });

    const ledger = await env.ledger();
    expect(ledger.map((e: any) => e.status)).toEqual(['ignored', 'ignored', 'ignored']);
    expect(env.events.emitted).toHaveLength(0);
  });

  it('keeps the event body only when storePayload is on', async () => {
    const env = await withOpenCharge({ webhooks: { storePayload: true } });
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
      {
        process: false,
      },
    );
    const [entry] = await env.ledger();
    expect(entry.payload).toMatchObject({ object: { id: env.providerCharge.id } });
    expect(entry.status).toBe('received');
  });

  it('records the failure and rethrows when the provider cannot be read, then recovers', async () => {
    const env = await withOpenCharge();
    env.fake.payCharge(env.providerCharge.id);
    const delivery = env.fake.event('charge', env.providerCharge.id);
    const queued = await deliverTestWebhook(env.payments, env.ctx, delivery, { process: false });
    env.fake.failNext('resolveEvent', new Error('provider unavailable'));
    const worker = withAuth(env.ctx, paymentsServiceAuth('tenant-a'));
    const input = {
      ledgerId: queued.ledgerId,
      provider: 'fake',
      providerEventId: 'x',
      type: 'charge.updated',
    };
    const failed = await executeCapability(
      env.payments.capabilities.processProviderEvent,
      worker,
      input,
    );
    expect(failed.success).toBe(false);
    expect((await env.ledger())[0]).toMatchObject({
      status: 'failed',
      error: 'provider unavailable',
    });

    const retried = await executeCapability(
      env.payments.capabilities.processProviderEvent,
      worker,
      input,
    );
    expect(retried.success).toBe(true);
    expect((await env.row()).status).toBe('paid');
  });

  it('only the payments service account can run the internal capabilities', async () => {
    const env = await withOpenCharge();
    for (const name of [
      'recordProviderEvent',
      'applyProviderState',
      'processProviderEvent',
    ] as const) {
      const result = await env.tryRun(name, {});
      expect(result.success).toBe(false);
    }
    const denied = await executeCapability(env.payments.capabilities.applyProviderState, env.ctx, {
      ledgerId: 'x',
      observedAt: new Date().toISOString(),
      changes: [],
    });
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('forbidden');
  });
});

describe('payments made outside the app', () => {
  it('skips provider references that are not local ids instead of querying with them', async () => {
    const env = await withOpenCharge();
    const providerCharge = env.fake.charges.get(env.providerCharge.id);
    if (!providerCharge) throw new Error('missing');
    providerCharge.reference = 'seller-dashboard-order-17';
    const findById = (env.ctx.data as any).PaymentCharge.findById;
    let looked = false;
    (env.ctx.data as any).PaymentCharge.findById = async (id: string) => {
      looked = true;
      return findById(id);
    };
    env.fake.payCharge(env.providerCharge.id);
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );
    expect(looked).toBe(false);
    // Still matched by the provider charge id, so the app's own charge is updated.
    expect((await env.row()).status).toBe('paid');
  });
});

describe('webhooks that race the provider response', () => {
  it('keeps one refund with the webhook state when refund.updated lands before createRefund returns', async () => {
    const env = await withOpenCharge();
    env.fake.payCharge(env.providerCharge.id);
    await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('charge', env.providerCharge.id),
    );

    const createRefund = env.fake.createRefund.bind(env.fake);
    env.fake.createRefund = async (input) => {
      const created = await createRefund(input);
      env.fake.settleRefund(created.id, 'succeeded');
      await deliverTestWebhook(env.payments, env.ctx, env.fake.event('refund', created.id));
      return created; // the provider's response still says "pending"
    };

    const { refund, created } = await env.run<any>('refundCharge', {
      chargeId: env.charge.id,
      amount: 700,
    });
    expect(created).toBe(true);
    const rows = await (env.ctx.data as any).PaymentRefund.findMany({ chargeId: env.charge.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: refund.id, status: 'succeeded' });
    expect(rows[0].providerRefundId).toMatch(/^re_fake_/);
    expect((await env.row()).amountRefunded).toBe(700);
  });

  it('keeps the paid state when the payment webhook lands before createCharge returns', async () => {
    const env = await onboardedSeller();
    const createCharge = env.fake.createCharge.bind(env.fake);
    env.fake.createCharge = async (input) => {
      const created = await createCharge(input);
      env.fake.payCharge(created.id);
      await deliverTestWebhook(env.payments, env.ctx, env.fake.event('charge', created.id));
      return created; // snapshot from creation time: status "open"
    };
    const { charge } = await env.run<any>('createCharge', {
      amount: 900,
      currency: 'usd',
      description: 'Fast payer',
    });
    const row = await (env.ctx.data as any).PaymentCharge.findById(charge.id);
    expect(row.status).toBe('paid');
    expect(row.providerChargeId).toMatch(/^cs_fake_/);
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);
  });

  it('leaves no local row when the provider rejects the charge or the refund', async () => {
    const env = await onboardedSeller();
    env.fake.failNext('createCharge', new Error('card network down'));
    const failed = await env.tryRun('createCharge', {
      amount: 900,
      currency: 'usd',
      description: 'x',
    });
    expect(failed.success).toBe(false);
    expect(await (env.ctx.data as any).PaymentCharge.findMany({})).toHaveLength(0);

    const { charge } = await env.run<any>('createCharge', {
      amount: 900,
      currency: 'usd',
      description: 'y',
    });
    const providerCharge = [...env.fake.charges.values()][0];
    if (!providerCharge) throw new Error('missing');
    env.fake.payCharge(providerCharge.id);
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('charge', providerCharge.id));
    env.fake.failNext('createRefund', new Error('insufficient balance'));
    const refund = await env.tryRun('refundCharge', { chargeId: charge.id });
    expect(refund.success).toBe(false);
    expect(await (env.ctx.data as any).PaymentRefund.findMany({})).toHaveLength(0);
  });
});
