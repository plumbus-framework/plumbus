import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { percentOf } from '../runtime/runtime.js';
import { onboardedSeller, setup } from './helpers.js';

describe('percentOf', () => {
  it('rounds half-up with exact integer math', () => {
    expect(percentOf(1000, 2.9)).toBe(29);
    expect(percentOf(1050, 5)).toBe(53); // 52.5 → 53
    expect(percentOf(1049, 5)).toBe(52); // 52.45 → 52
    expect(percentOf(1, 50)).toBe(1); // 0.5 → 1
    expect(percentOf(999_999_999_999, 1.5)).toBe(15_000_000_000);
    expect(percentOf(1234, 0)).toBe(0);
    expect(percentOf(1234, 100)).toBe(1234);
  });
});

describe('createCharge', () => {
  it('refuses until the seller can take payments', async () => {
    const env = setup();
    await env.run('startMerchantOnboarding', {});
    const result = await env.tryRun('createCharge', {
      amount: 5000,
      currency: 'usd',
      description: 'Lesson',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('conflict');
  });

  it('creates a hosted payment link on the seller account with the platform fee', async () => {
    const env = await onboardedSeller({ platformFee: { percent: 5, fixed: { usd: 30 } } });
    const { charge, created } = await env.run<any>('createCharge', {
      amount: 5000,
      currency: 'usd',
      description: 'Private lesson',
      metadata: { lessonId: 'l-1' },
    });

    expect(created).toBe(true);
    expect(charge).toMatchObject({
      status: 'open',
      amount: 5000,
      currency: 'usd',
      platformFeeAmount: 280,
      amountRefunded: 0,
      description: 'Private lesson',
      metadata: { lessonId: 'l-1' },
      livemode: false,
    });
    expect(charge.url).toMatch(/^https:\/\/pay\.fake\.test\/cs_fake_/);

    const input = env.fake.calls.find((c) => c.method === 'createCharge')?.input as any;
    expect(input).toMatchObject({
      flow: 'direct',
      sellerAccountId: env.accountId,
      reference: charge.id,
      items: [{ name: 'Private lesson', unitAmount: 5000, quantity: 1 }],
      platformFeeAmount: 280,
      successUrl: `https://app.test/paid/${charge.id}`,
      cancelUrl: `https://app.test/cancelled/${charge.id}`,
      idempotencyKey: `plumbus-charge:${charge.id}`,
    });
    expect(input.metadata).toMatchObject({
      plumbus_charge_id: charge.id,
      plumbus_owner_id: 'seller-1',
      plumbus_tenant_id: 'tenant-a',
    });
    expect(new Date(input.expiresAt).getTime() - env.ctx.time.now().getTime()).toBe(1440 * 60_000);

    expect(env.emitted(PaymentEventName.ChargeCreated)).toEqual([
      expect.objectContaining({
        chargeId: charge.id,
        amount: 5000,
        platformFeeAmount: 280,
        createdBy: 'seller-1',
      }),
    ]);
  });

  it('uses a fee function for per-seller pricing and rejects fees above the amount', async () => {
    const env = await onboardedSeller({
      platformFee: ({ amount, merchant }) => (merchant.ownerId === 'seller-1' ? amount + 1 : 0),
    });
    const result = await env.tryRun('createCharge', {
      amount: 100,
      currency: 'usd',
      description: 'x',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('larger than the charge');
  });

  it('returns the same charge for a repeated requestId and refuses a changed amount', async () => {
    const env = await onboardedSeller();
    const input = { amount: 2500, currency: 'usd', description: 'Deposit', requestId: 'req-1' };
    const first = await env.run<any>('createCharge', input);
    const again = await env.run<any>('createCharge', input);
    expect(again.created).toBe(false);
    expect(again.charge.id).toBe(first.charge.id);
    expect(env.fake.charges.size).toBe(1);

    const changed = await env.tryRun('createCharge', { ...input, amount: 9999 });
    expect(changed.success).toBe(false);
    if (!changed.success) expect(changed.error.code).toBe('conflict');
  });

  it('reuses one provider customer per client and enforces allowed currencies', async () => {
    const env = await onboardedSeller({ currencies: ['usd', 'eur'] });
    const client = { email: 'client@example.com', name: 'Client', reference: 'crm-7' };
    const a = await env.run<any>('createCharge', {
      amount: 100,
      currency: 'usd',
      description: 'a',
      client,
    });
    const b = await env.run<any>('createCharge', {
      amount: 200,
      currency: 'eur',
      description: 'b',
      client,
    });
    expect(a.charge.clientId).toBe(b.charge.clientId);
    expect(env.fake.calls.filter((c) => c.method === 'createClient')).toHaveLength(1);
    expect(a.charge.clientEmail).toBe('client@example.com');

    const gbp = await env.tryRun('createCharge', {
      amount: 100,
      currency: 'gbp',
      description: 'c',
    });
    expect(gbp.success).toBe(false);
  });

  it('rejects reserved metadata keys and non-integer amounts', async () => {
    const env = await onboardedSeller();
    const reserved = await env.tryRun('createCharge', {
      amount: 100,
      currency: 'usd',
      description: 'x',
      metadata: { plumbus_charge_id: 'spoof' },
    });
    expect(reserved.success).toBe(false);
    const fractional = await env.tryRun('createCharge', {
      amount: 10.5,
      currency: 'usd',
      description: 'x',
    });
    expect(fractional.success).toBe(false);
    const upper = await env.tryRun('createCharge', {
      amount: 10,
      currency: 'USD',
      description: 'x',
    });
    expect(upper.success).toBe(false);
  });
});

describe('reading charges', () => {
  it("lists only the caller's charges and hides other sellers' charges", async () => {
    const env = await onboardedSeller();
    const mine = await env.run<any>('createCharge', {
      amount: 100,
      currency: 'usd',
      description: 'mine',
    });

    await env.run('startMerchantOnboarding', {}, env.as('seller-2'));
    const otherAccount = [...env.fake.accounts.keys()][1] as string;
    env.fake.completeOnboarding(otherAccount);
    await env.run('syncMerchantAccount', {}, env.as('seller-2'));
    const theirs = await env.run<any>(
      'createCharge',
      { amount: 300, currency: 'usd', description: 'theirs' },
      env.as('seller-2'),
    );

    const listed = await env.run<any>('listCharges', {});
    expect(listed.charges.map((c: any) => c.id)).toEqual([mine.charge.id]);

    const peek = await env.tryRun('getCharge', { chargeId: theirs.charge.id });
    expect(peek.success).toBe(false);
    if (!peek.success) expect(peek.error.code).toBe('notFound');

    const own = await env.run<any>('getCharge', { chargeId: mine.charge.id });
    expect(own).toMatchObject({ charge: { id: mine.charge.id }, refunds: [] });

    const open = await env.run<any>('listCharges', { status: 'paid' });
    expect(open.charges).toEqual([]);
  });
});

describe('refundCharge', () => {
  async function paidCharge() {
    const env = await onboardedSeller({ refunds: { refundPlatformFee: true } });
    const { charge } = await env.run<any>('createCharge', {
      amount: 1000,
      currency: 'usd',
      description: 'x',
    });
    const providerCharge = [...env.fake.charges.values()][0];
    if (!providerCharge) throw new Error('no charge');
    env.fake.payCharge(providerCharge.id);
    const repo = (env.ctx.data as any).PaymentCharge;
    await repo.update(charge.id, { status: 'paid', providerPaymentId: providerCharge.paymentId });
    return { ...env, charge, providerCharge };
  }

  it('refuses unpaid charges', async () => {
    const env = await onboardedSeller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 1000,
      currency: 'usd',
      description: 'x',
    });
    const result = await env.tryRun('refundCharge', { chargeId: charge.id });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('Only paid charges');
  });

  it('refunds part, then the rest, never more than was paid', async () => {
    const env = await paidCharge();
    const part = await env.run<any>('refundCharge', {
      chargeId: env.charge.id,
      amount: 400,
      reason: 'requested_by_customer',
    });
    expect(part.refund).toMatchObject({
      amount: 400,
      status: 'pending',
      reason: 'requested_by_customer',
    });
    const refundInput = env.fake.calls.find((c) => c.method === 'createRefund')?.input as any;
    expect(refundInput).toMatchObject({
      amount: 400,
      refundPlatformFee: true,
      paymentId: env.providerCharge.paymentId,
    });

    const tooMuch = await env.tryRun('refundCharge', { chargeId: env.charge.id, amount: 700 });
    expect(tooMuch.success).toBe(false);
    if (!tooMuch.success) expect(tooMuch.error.message).toContain('At most 600');

    const rest = await env.run<any>('refundCharge', { chargeId: env.charge.id });
    expect(rest.refund.amount).toBe(600);
  });

  it('returns the same refund for a repeated requestId', async () => {
    const env = await paidCharge();
    const first = await env.run<any>('refundCharge', {
      chargeId: env.charge.id,
      amount: 100,
      requestId: 'r-1',
    });
    const again = await env.run<any>('refundCharge', {
      chargeId: env.charge.id,
      amount: 100,
      requestId: 'r-1',
    });
    expect(again).toEqual({ refund: first.refund, created: false });
    expect(env.fake.refunds.size).toBe(1);
  });

  it('uses access.refunds when it is narrower than access.sellers', async () => {
    const env = await onboardedSeller({
      access: { sellers: { roles: ['seller'] }, refunds: { roles: ['refunder'] } },
    });
    const result = await env.tryRun('refundCharge', { chargeId: crypto.randomUUID() });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('forbidden');
  });
});

describe('ids', () => {
  it('rejects non-uuid charge ids as validation errors before any lookup', async () => {
    const env = await onboardedSeller();
    for (const name of ['getCharge', 'refundCharge'] as const) {
      const result = await env.tryRun(name, { chargeId: 'not-a-uuid' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('validation');
    }
  });
});
