// Edge cases found by probing the implementation: retries, races, provider
// quirks, and inputs the happy-path tests never send. Each test states the
// behavior that must hold.

import { randomUUID } from 'node:crypto';
import { executeCapability } from '@plumbus/core';
import type { TestContextOptions } from '@plumbus/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { serializeChange } from '../capabilities/schemas.js';
import { PaymentEventName } from '../events/index.js';
import { paymentsServiceAuth } from '../runtime/ingest.js';
import { fillUrl, percentOf } from '../runtime/runtime.js';
import { deliverTestWebhook, withAuth } from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { onboardedSeller, tickingClock } from './helpers.js';

/** The `metadata.reason` of a failed capability result. */
function reasonOf(result: { success: boolean }): unknown {
  return 'error' in result
    ? (result.error as { metadata?: { reason?: unknown } }).metadata?.reason
    : undefined;
}

function only<T>(map: Map<string, T>): T {
  const values = [...map.values()];
  if (values.length !== 1) throw new Error(`expected one entry, found ${values.length}`);
  return values[0] as T;
}

async function openCharge(
  config: Partial<PaymentsConfig> = {},
  context: Pick<TestContextOptions, 'time'> = {},
) {
  const env = await onboardedSeller(config, context);
  const { charge } = await env.run<any>('createCharge', {
    amount: 2000,
    currency: 'usd',
    description: 'Session',
  });
  const providerCharge = only(env.fake.charges);
  const data = env.ctx.data as any;
  const deliver = (objectType: 'account' | 'charge' | 'refund', id: string) =>
    deliverTestWebhook(env.payments, env.ctx, env.fake.event(objectType, id));
  env.events.clear();
  return {
    ...env,
    charge,
    providerCharge,
    data,
    deliver,
    row: () => data.PaymentCharge.findById(charge.id),
  };
}

async function paidCharge(
  config: Partial<PaymentsConfig> = {},
  context: Pick<TestContextOptions, 'time'> = {},
) {
  const env = await openCharge(config, context);
  env.fake.payCharge(env.providerCharge.id);
  await env.deliver('charge', env.providerCharge.id);
  env.events.clear();
  return env;
}

describe('webhook processing', () => {
  it('processes a redelivered event whose first processing failed', async () => {
    const env = await openCharge();
    env.fake.payCharge(env.providerCharge.id);
    const delivery = env.fake.event('charge', env.providerCharge.id, { eventId: 'evt_retry' });

    env.fake.failNext('resolveEvent', new Error('provider timed out'));
    await expect(deliverTestWebhook(env.payments, env.ctx, delivery)).rejects.toThrow();
    expect((await env.row()).status).toBe('open');

    // The provider (or an operator) resends the event after the worker gave up.
    const again = await deliverTestWebhook(env.payments, env.ctx, delivery);
    expect(again.processed).toMatchObject({ status: 'processed' });
    expect((await env.row()).status).toBe('paid');
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);
  });

  it('emits charge.paid once when two events for one charge are processed at the same time', async () => {
    const env = await openCharge();
    env.fake.payCharge(env.providerCharge.id);
    await Promise.all([
      env.deliver('charge', env.providerCharge.id),
      env.deliver('charge', env.providerCharge.id),
    ]);
    expect((await env.row()).status).toBe('paid');
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);
  });

  it('emits refund.failed once when two workers apply the same failure at once', async () => {
    const env = await paidCharge();
    await env.run('refundCharge', { chargeId: env.charge.id, amount: 500 });
    const providerRefund = only(env.fake.refunds);
    env.fake.settleRefund(providerRefund.id, 'failed', 'expired_or_canceled_card');
    await Promise.all([
      env.deliver('refund', providerRefund.id),
      env.deliver('refund', providerRefund.id),
    ]);
    expect(env.emitted(PaymentEventName.RefundFailed)).toHaveLength(1);
  });

  it('emits dispute.closed once when two workers apply the same outcome at once', async () => {
    const env = await paidCharge();
    const dispute = env.fake.openDispute(env.providerCharge.id);
    const deliverDispute = () =>
      deliverTestWebhook(env.payments, env.ctx, env.fake.event('dispute', dispute.id));
    await deliverDispute();
    env.fake.setDisputeStatus(dispute.id, 'won');
    await Promise.all([deliverDispute(), deliverDispute()]);
    expect(env.emitted(PaymentEventName.DisputeClosed)).toHaveLength(1);
    expect(await env.data.PaymentDispute.findMany({})).toHaveLength(1);
  });

  it('ignores a payment for another amount while the charge still awaits its page', async () => {
    const env = await openCharge();
    // The provider call has not answered yet: the row has no page of its own.
    await env.data.PaymentCharge.update(env.charge.id, {
      providerChargeId: `pending:${env.charge.id}`,
    });
    env.fake.charges.set('cs_cheaper', {
      ...env.providerCharge,
      id: 'cs_cheaper',
      amountSubtotal: 50,
      amountTotal: 50,
      status: 'paid',
      paymentId: 'pi_cheaper',
      paidAt: new Date(),
      url: null,
    });
    await env.deliver('charge', 'cs_cheaper');
    expect(await env.row()).toMatchObject({ status: 'open' });
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(0);

    // The page for the charge's own amount is applied.
    env.fake.payCharge(env.providerCharge.id);
    await env.deliver('charge', env.providerCharge.id);
    expect(await env.row()).toMatchObject({
      status: 'paid',
      providerChargeId: env.providerCharge.id,
    });
  });

  it('ignores a provider payment that carries our charge id but is not its page', async () => {
    const env = await openCharge();
    // A seller with a full dashboard can create their own checkout with any reference.
    env.fake.charges.set('cs_elsewhere', {
      ...env.providerCharge,
      id: 'cs_elsewhere',
      amountSubtotal: 50,
      amountTotal: 50,
      status: 'paid',
      paymentId: 'pi_elsewhere',
      paidAt: new Date(),
      url: null,
    });
    await env.deliver('charge', 'cs_elsewhere');

    expect(await env.row()).toMatchObject({
      status: 'open',
      providerChargeId: env.providerCharge.id,
    });
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(0);

    // Nor does a refund of that other payment land on our charge.
    const outside = await env.fake.createRefund({
      routing: {
        flow: 'direct',
        sellerAccountId: env.accountId,
        onBehalfOf: false,
        transferGroup: null,
      },
      reverseTransfer: false,
      paymentId: 'pi_elsewhere',
      reference: 'n/a',
      amount: 50,
      refundPlatformFee: false,
      metadata: {},
      idempotencyKey: 'outside-refund',
    });
    await env.deliver('refund', outside.id);
    expect(await env.data.PaymentRefund.findMany({})).toHaveLength(0);
  });

  it('lowers the refunded amount again when a refund fails after succeeding', async () => {
    const env = await paidCharge();
    await env.run('refundCharge', { chargeId: env.charge.id });
    const providerRefund = only(env.fake.refunds);
    env.fake.settleRefund(providerRefund.id, 'succeeded');
    await env.deliver('refund', providerRefund.id);
    expect((await env.row()).amountRefunded).toBe(2000);

    // The client's bank returns the money; the provider gives it back to the seller.
    env.fake.settleRefund(providerRefund.id, 'failed', 'lost_or_stolen_card');
    env.providerCharge.amountRefunded -= providerRefund.amount;
    await env.deliver('refund', providerRefund.id);

    expect((await env.row()).amountRefunded).toBe(0);
    expect(env.emitted(PaymentEventName.RefundFailed)).toHaveLength(1);
    const retry = await env.tryRun('refundCharge', { chargeId: env.charge.id });
    expect(retry.success).toBe(true);
  });

  it('does not report a seller change when only the order of requirements changed', async () => {
    const env = await onboardedSeller();
    const account = env.fake.accounts.get(env.accountId);
    if (!account) throw new Error('no account');
    const deliver = () =>
      deliverTestWebhook(env.payments, env.ctx, env.fake.event('account', env.accountId));

    account.requirementsDue = ['Tax ID', 'Bank account'];
    await deliver();
    env.events.clear();
    account.requirementsDue = ['Bank account', 'Tax ID'];
    await deliver();

    expect(env.emitted(PaymentEventName.MerchantUpdated)).toHaveLength(0);
  });

  it('applies provider state a worker read while the refund call was still returning', async () => {
    const clock = tickingClock();
    const env = await paidCharge({}, { time: clock });
    const createRefund = env.fake.createRefund.bind(env.fake);
    let workerStartedAt: Date | undefined;
    vi.spyOn(env.fake, 'createRefund').mockImplementationOnce(async (input) => {
      const created = await createRefund(input);
      // The refund's webhook reaches a worker before this response is handled,
      // and the refund settles before the worker reads it.
      workerStartedAt = clock.now();
      env.fake.settleRefund(created.id, 'succeeded');
      return created;
    });
    const { refund } = await env.run<any>('refundCharge', { chargeId: env.charge.id, amount: 500 });
    expect(refund.status).toBe('pending');

    const providerRefund = only(env.fake.refunds);
    const recorded = await deliverTestWebhook(
      env.payments,
      env.ctx,
      env.fake.event('refund', providerRefund.id),
      { process: false },
    );
    const changes = await env.fake.resolveEvent({
      eventId: 'evt_refund',
      type: 'refund.updated',
      format: 'thin',
      livemode: false,
      accountId: env.accountId,
      objectId: providerRefund.id,
      objectType: 'refund',
    });
    const worker = withAuth(env.ctx, paymentsServiceAuth('tenant-a'));
    const applied = await executeCapability(env.payments.capabilities.applyProviderState, worker, {
      ledgerId: recorded.ledgerId,
      observedAt: workerStartedAt?.toISOString(),
      changes: changes.map(serializeChange),
    });
    expect(applied.success).toBe(true);

    expect((await env.data.PaymentRefund.findById(refund.id)).status).toBe('succeeded');
  });
});

describe('seller accounts', () => {
  it('syncMerchantAccount keeps fresher state that a webhook applied during the sync', async () => {
    const clock = tickingClock();
    const env = await onboardedSeller({}, { time: clock });
    env.fake.restrictAccount(env.accountId, 'Tax ID');
    const retrieve = env.fake.retrieveMerchantAccount.bind(env.fake);
    vi.spyOn(env.fake, 'retrieveMerchantAccount').mockImplementationOnce(async (accountId) => {
      const snapshot = await retrieve(accountId);
      // While the response travels back, the seller fixes the problem and the
      // provider's webhook is applied first.
      env.fake.completeOnboarding(accountId);
      await deliverTestWebhook(env.payments, env.ctx, env.fake.event('account', accountId));
      return snapshot;
    });

    const synced = await env.run<any>('syncMerchantAccount', {});
    expect(synced.merchantAccount.status).toBe('active');
    const stored = await env.run<any>('getMerchantAccount', {});
    expect(stored.merchantAccount).toMatchObject({ status: 'active', chargesEnabled: true });
  });

  it('refuses new charges once the seller account is closed', async () => {
    const env = await onboardedSeller();
    env.fake.closeAccount(env.accountId);
    await deliverTestWebhook(env.payments, env.ctx, env.fake.event('account', env.accountId));

    const result = await env.tryRun('createCharge', {
      amount: 1000,
      currency: 'usd',
      description: 'After closing',
    });
    expect(result.success).toBe(false);
    expect(reasonOf(result)).toBe('payments_charges_disabled');
  });
});

describe('charges', () => {
  const lesson = {
    amount: 2000,
    currency: 'usd',
    description: 'Lesson 1',
    client: { email: 'parent@example.com' },
    requestId: 'lesson-1',
  };

  it('refuses a requestId reused with a different description', async () => {
    const env = await onboardedSeller();
    await env.run('createCharge', lesson);
    const reused = await env.tryRun('createCharge', { ...lesson, description: 'Lesson 2' });
    expect(reused.success).toBe(false);
    expect(reasonOf(reused)).toBe('payments_request_id_reused');
    expect((await env.run<any>('createCharge', lesson)).created).toBe(false);
  });

  it('refuses a requestId reused for a different client', async () => {
    const env = await onboardedSeller();
    await env.run('createCharge', lesson);
    const reused = await env.tryRun('createCharge', {
      ...lesson,
      client: { email: 'someone-else@example.com' },
    });
    expect(reused.success).toBe(false);
    expect(reasonOf(reused)).toBe('payments_request_id_reused');
  });

  it('keeps two clients who share an email apart when the app names them', async () => {
    const env = await onboardedSeller();
    const charge = (reference: string) =>
      env.run<any>('createCharge', {
        amount: 1000,
        currency: 'usd',
        description: `Lesson for ${reference}`,
        client: { reference, email: 'family@example.com' },
      });
    const first = await charge('student-1');
    const second = await charge('student-2');
    expect(second.charge.clientId).not.toBe(first.charge.clientId);
  });

  it('finds a client first charged by email when the app later adds its reference', async () => {
    const env = await onboardedSeller();
    const charge = (client: Record<string, string>, n: number) =>
      env.run<any>('createCharge', {
        amount: 1000,
        currency: 'usd',
        description: `Lesson ${n}`,
        client,
      });
    const byEmail = await charge({ email: 'family@example.com' }, 1);
    const named = await charge({ reference: 'student-1', email: 'family@example.com' }, 2);
    const newEmail = await charge({ reference: 'student-1', email: 'new@example.com' }, 3);
    expect(named.charge.clientId).toBe(byEmail.charge.clientId);
    expect(newEmail.charge.clientId).toBe(byEmail.charge.clientId);
  });

  it('creates one client when two charges for a new client run at the same time', async () => {
    const env = await onboardedSeller();
    const charge = (n: number) =>
      env.run<any>('createCharge', {
        amount: 1000,
        currency: 'usd',
        description: `Lesson ${n}`,
        client: { reference: 'student-1', email: 'family@example.com' },
      });
    const [first, second] = await Promise.all([charge(1), charge(2)]);
    expect(second.charge.clientId).toBe(first.charge.clientId);
    const clients = await (env.ctx.data as any).PaymentClient.findMany({});
    expect(clients).toHaveLength(1);
    const providerClients = new Set(
      env.fake.calls
        .filter((call) => call.method === 'createClient')
        .map((call) => (call.input as { idempotencyKey: string }).idempotencyKey),
    );
    expect(providerClients.size).toBe(1);
  });

  it('finishes a charge a crash left half-created when the requestId is retried', async () => {
    const env = await onboardedSeller();
    const merchant = (await env.run<any>('getMerchantAccount', {})).merchantAccount;
    // What a crash between saving the charge and calling the provider leaves behind.
    const id = randomUUID();
    await (env.ctx.data as any).PaymentCharge.create({
      id,
      tenantId: 'tenant-a',
      merchantAccountId: merchant.id,
      clientId: null,
      provider: 'fake',
      providerChargeId: `pending:${id}`,
      providerPaymentId: null,
      flow: 'direct',
      collection: 'checkout',
      ui: 'hosted',
      capture: 'automatic',
      saveMethod: false,
      customAmount: false,
      items: [{ name: 'Lesson 9', unitAmount: 2000, quantity: 1 }],
      requestId: 'lesson-9',
      status: 'open',
      amount: 2000,
      currency: 'usd',
      platformFeeAmount: 0,
      amountRefunded: 0,
      description: 'Lesson 9',
      url: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      paidAt: null,
      clientEmail: null,
      createdBy: 'seller-1',
      metadata: null,
      livemode: false,
      syncedAt: null,
    });

    const retry = await env.run<any>('createCharge', {
      amount: 2000,
      currency: 'usd',
      description: 'Lesson 9',
      requestId: 'lesson-9',
    });
    expect(retry.charge.id).toBe(id);
    expect(retry.charge.url).toMatch(/^https:\/\//);
    expect(env.fake.charges.size).toBe(1);
  });
});

/** What a crash between saving a refund and hearing back from the provider leaves behind. */
async function refundLostInCrash(env: Awaited<ReturnType<typeof paidCharge>>, amount: number) {
  const id = randomUUID();
  await env.data.PaymentRefund.create({
    id,
    tenantId: 'tenant-a',
    chargeId: env.charge.id,
    merchantAccountId: env.charge.merchantAccountId,
    provider: 'fake',
    providerRefundId: `pending:${id}`,
    requestId: null,
    amount,
    currency: 'usd',
    status: 'pending',
    reason: null,
    failureReason: null,
    requestedBy: 'seller-1',
    syncedAt: null,
    // An hour before the test clock: long after any provider call would have ended.
    createdAt: new Date(env.ctx.time.now().getTime() - 3_600_000),
  });
  return id;
}

describe('refunds', () => {
  it('drops a refund that a crash kept from reaching the provider', async () => {
    const env = await paidCharge();
    const lost = await refundLostInCrash(env, 800);

    const full = await env.run<any>('refundCharge', { chargeId: env.charge.id, amount: 2000 });
    expect(full.refund.amount).toBe(2000);
    expect(await env.data.PaymentRefund.findById(lost)).toBeNull();
  });

  it('keeps a refund that reached the provider before the crash', async () => {
    const env = await paidCharge();
    const lost = await refundLostInCrash(env, 800);
    await env.fake.createRefund({
      routing: {
        flow: 'direct',
        sellerAccountId: env.accountId,
        onBehalfOf: false,
        transferGroup: null,
      },
      reverseTransfer: false,
      paymentId: env.providerCharge.paymentId as string,
      reference: lost,
      amount: 800,
      refundPlatformFee: false,
      metadata: {},
      idempotencyKey: `plumbus-refund:${lost}`,
    });

    const tooMuch = await env.tryRun('refundCharge', { chargeId: env.charge.id, amount: 2000 });
    expect(reasonOf(tooMuch)).toBe('payments_refund_exceeds_charge');
    const stored = await env.data.PaymentRefund.findById(lost);
    expect(stored.providerRefundId).toMatch(/^re_fake_/);
    const rest = await env.run<any>('refundCharge', { chargeId: env.charge.id, amount: 1200 });
    expect(rest.refund.amount).toBe(1200);
  });

  it('asks the provider for the same refund when a requestId is retried after a lost response', async () => {
    const env = await paidCharge();
    const createRefund = env.fake.createRefund.bind(env.fake);
    vi.spyOn(env.fake, 'createRefund').mockImplementationOnce(async (input) => {
      await createRefund(input);
      throw new Error('socket hang up');
    });
    const input = { chargeId: env.charge.id, amount: 500, requestId: 'refund-1' };
    expect((await env.tryRun('refundCharge', input)).success).toBe(false);
    const retry = await env.run<any>('refundCharge', input);

    const sent = env.fake.calls.filter((c) => c.method === 'createRefund').map((c) => c.input);
    expect(sent).toHaveLength(2);
    // Providers reject a reused idempotency key when any parameter differs.
    expect(sent[1]).toEqual(sent[0]);
    expect(env.fake.refunds.size).toBe(1);
    expect(retry.refund.amount).toBe(500);

    const reused = await env.tryRun('refundCharge', { ...input, amount: 600 });
    expect(reasonOf(reused)).toBe('payments_request_id_reused');
  });

  it('keeps the webhook-recorded refund when its webhook lands before the retry', async () => {
    const env = await paidCharge();
    const createRefund = env.fake.createRefund.bind(env.fake);
    vi.spyOn(env.fake, 'createRefund').mockImplementationOnce(async (input) => {
      await createRefund(input);
      throw new Error('socket hang up');
    });
    const input = { chargeId: env.charge.id, amount: 500, requestId: 'refund-1' };
    expect((await env.tryRun('refundCharge', input)).success).toBe(false);
    await env.deliver('refund', only(env.fake.refunds).id);

    const retry = await env.run<any>('refundCharge', input);
    expect(retry.created).toBe(false);
    const rows = await env.data.PaymentRefund.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: retry.refund.id, requestId: 'refund-1', amount: 500 });
    expect((await env.run<any>('refundCharge', input)).refund.id).toBe(retry.refund.id);
  });

  it('sends a refund a crash left unsent when its requestId is retried', async () => {
    const env = await paidCharge();
    const refundId = randomUUID();
    await env.data.PaymentRefund.create({
      id: refundId,
      tenantId: 'tenant-a',
      chargeId: env.charge.id,
      merchantAccountId: env.charge.merchantAccountId,
      provider: 'fake',
      providerRefundId: `pending:${refundId}`,
      requestId: 'refund-9',
      amount: 300,
      currency: 'usd',
      status: 'pending',
      reason: null,
      failureReason: null,
      requestedBy: 'seller-1',
      syncedAt: null,
    });

    const retry = await env.run<any>('refundCharge', {
      chargeId: env.charge.id,
      requestId: 'refund-9',
    });
    expect(retry.refund).toMatchObject({ id: refundId, amount: 300 });
    expect(only(env.fake.refunds)).toMatchObject({ reference: refundId, amount: 300 });
    const stored = await env.data.PaymentRefund.findById(refundId);
    expect(stored.providerRefundId).toMatch(/^re_fake_/);
  });

  it('counts a pending refund once when the provider already includes it in the refunded amount', async () => {
    const env = await paidCharge();
    await env.run('refundCharge', { chargeId: env.charge.id, amount: 500 });
    const providerRefund = only(env.fake.refunds);
    // Stripe raises the charge's amount_refunded as soon as a refund is created.
    env.providerCharge.amountRefunded = 500;
    await env.deliver('refund', providerRefund.id);
    expect(await env.data.PaymentRefund.findById(providerRefund.reference)).toMatchObject({
      status: 'pending',
    });

    const rest = await env.tryRun('refundCharge', { chargeId: env.charge.id, amount: 1500 });
    expect(rest.success).toBe(true);
  });

  it('keeps one refund when two full refunds race and the provider rejects the second', async () => {
    const env = await paidCharge();
    const createRefund = env.fake.createRefund.bind(env.fake);
    vi.spyOn(env.fake, 'createRefund').mockImplementation(async (input) => {
      const refunded = [...env.fake.refunds.values()]
        .filter((r) => r.paymentId === input.paymentId && r.status !== 'failed')
        .reduce((sum, r) => sum + r.amount, 0);
      if (refunded + (input.amount ?? 0) > (env.providerCharge.amountTotal ?? 0)) {
        throw new Error('Refund amount is greater than the unrefunded amount');
      }
      return createRefund(input);
    });

    const results = await Promise.all([
      env.tryRun('refundCharge', { chargeId: env.charge.id }),
      env.tryRun('refundCharge', { chargeId: env.charge.id }),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(await env.data.PaymentRefund.findMany({})).toHaveLength(1);
  });
});

describe('fees and urls', () => {
  it('computes percentage fees exactly, including fine fractions', () => {
    expect(percentOf(1_000_001, 2.9)).toBe(29_000);
    expect(percentOf(5, 10)).toBe(1);
    expect(percentOf(Number.MAX_SAFE_INTEGER, 100)).toBe(Number.MAX_SAFE_INTEGER);
    expect(percentOf(1_000_000_000, 0.00005)).toBe(500);
    expect(percentOf(1_000_000_000, 1.23456789)).toBe(12_345_679);
  });

  it('leaves provider placeholders such as {CHECKOUT_SESSION_ID} in redirect urls', () => {
    expect(
      fillUrl('https://app.test/paid/{chargeId}?session={CHECKOUT_SESSION_ID}', { chargeId: 'c1' }),
    ).toBe('https://app.test/paid/c1?session={CHECKOUT_SESSION_ID}');
  });
});
