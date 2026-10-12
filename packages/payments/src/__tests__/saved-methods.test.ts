// Saving a client's payment method and charging it later without them
// (no-show fees, charging after the session), and the client portal.

import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { deliverTestWebhook } from '../testing/index.js';
import { onboardedSeller } from './helpers.js';

async function seller() {
  const env = await onboardedSeller({ platformFee: { percent: 10 } });
  const data = env.ctx.data as any;
  const deliver = (type: Parameters<typeof env.fake.event>[0], id: string) =>
    deliverTestWebhook(env.payments, env.ctx, env.fake.event(type, id));
  const lastInput = (method: string) =>
    [...env.fake.calls].reverse().find((c) => c.method === method)?.input as any;
  return { ...env, data, deliver, lastInput };
}

/** A client with a card saved through the setup page. */
async function clientWithCard(env: Awaited<ReturnType<typeof seller>>) {
  const saved = await env.run<any>('saveClientPaymentMethod', {
    client: { reference: 'student-1', email: 'parent@example.com' },
  });
  const session = [...env.fake.setupSessions.values()].at(-1);
  if (!session) throw new Error('no setup session');
  env.fake.completeSetup(session.id, { brand: 'mastercard', last4: '4444' });
  await env.deliver('setup', session.id);
  return { clientId: saved.clientId as string, session };
}

describe('saving a payment method', () => {
  it('sends the client to a setup page and records the card when it is saved', async () => {
    const env = await seller();
    const saved = await env.run<any>('saveClientPaymentMethod', {
      client: { reference: 'student-1', email: 'parent@example.com' },
    });
    expect(saved.url).toMatch(/^https:\/\/setup\.fake\.test\//);
    expect(env.lastInput('createSetupSession')).toMatchObject({
      sellerAccountId: env.accountId,
      successUrl: `https://app.test/saved/${saved.clientId}`,
    });

    const session = [...env.fake.setupSessions.values()][0];
    if (!session) throw new Error('no session');
    env.fake.completeSetup(session.id, { brand: 'mastercard', last4: '4444' });
    await env.deliver('setup', session.id);

    const { paymentMethods } = await env.run<any>('listClientPaymentMethods', {
      clientId: saved.clientId,
    });
    expect(paymentMethods).toEqual([
      expect.objectContaining({ brand: 'mastercard', last4: '4444', status: 'active' }),
    ]);
    expect(env.emitted(PaymentEventName.PaymentMethodSaved)).toEqual([
      expect.objectContaining({ clientId: saved.clientId, last4: '4444', ownerId: 'seller-1' }),
    ]);
  });

  it('keeps the method a client paid with when the charge asks to', async () => {
    const env = await seller();
    const { charge } = await env.run<any>('createCharge', {
      amount: 3000,
      currency: 'usd',
      description: 'First lesson',
      client: { reference: 'student-1' },
      saveMethod: true,
    });
    expect(env.lastInput('createCharge').saveMethod).toBe(true);
    const page = [...env.fake.charges.values()][0];
    if (!page) throw new Error('no page');
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    const stored = await env.data.PaymentCharge.findById(charge.id);
    expect(stored.paymentMethodId).toBeTruthy();
    const { paymentMethods } = await env.run<any>('listClientPaymentMethods', {
      clientId: charge.clientId,
    });
    expect(paymentMethods).toHaveLength(1);
  });

  it('removes a saved method at the provider', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    const [method] = (await env.run<any>('listClientPaymentMethods', { clientId })).paymentMethods;
    const removed = await env.run<any>('removeClientPaymentMethod', { paymentMethodId: method.id });
    expect(removed.paymentMethod.status).toBe('removed');
    expect([...env.fake.methods.values()][0]?.detached).toBe(true);
    expect((await env.run<any>('listClientPaymentMethods', { clientId })).paymentMethods).toEqual(
      [],
    );
  });

  it('pulls methods from the provider on sync', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    const [method] = [...env.fake.methods.values()];
    if (!method) throw new Error('no method');
    method.detached = true;
    const synced = await env.run<any>('syncClientPaymentMethods', { clientId });
    expect(synced.paymentMethods).toEqual([]);
  });

  it('marks a method removed when the client detaches it elsewhere (the event names no customer)', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    const [method] = [...env.fake.methods.values()];
    if (!method) throw new Error('no method');
    method.detached = true;
    const result = await env.deliver('payment_method', method.id);
    expect(result.processed).toMatchObject({ status: 'processed' });
    expect((await env.run<any>('listClientPaymentMethods', { clientId })).paymentMethods).toEqual(
      [],
    );
  });

  it('lists clients and opens the client portal', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    const { clients } = await env.run<any>('listClients', {});
    expect(clients).toEqual([expect.objectContaining({ id: clientId, reference: 'student-1' })]);
    const portal = await env.run<any>('createClientPortalSession', { clientId });
    expect(portal.url).toMatch(/^https:\/\/portal\.fake\.test\//);
    expect(env.lastInput('createPortalSession')).toMatchObject({
      sellerAccountId: env.accountId,
      returnUrl: 'https://app.test/account',
    });
  });
});

describe('charging a saved method', () => {
  it('charges without the client and announces the payment once', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    const { charge } = await env.run<any>('chargeSavedMethod', {
      clientId,
      amount: 4000,
      currency: 'usd',
      description: 'Missed lesson',
      requestId: 'no-show-1',
    });
    expect(charge).toMatchObject({
      status: 'paid',
      collection: 'saved_method',
      platformFeeAmount: 400,
    });
    expect(env.emitted(PaymentEventName.ChargeCreated)).toHaveLength(1);
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);

    // The payment's webhook arrives afterwards: no second event.
    const payment = [...env.fake.charges.values()].find((c) => c.kind === 'payment');
    if (!payment) throw new Error('no payment');
    await env.deliver('charge', payment.id);
    expect(env.emitted(PaymentEventName.ChargePaid)).toHaveLength(1);

    const again = await env.run<any>('chargeSavedMethod', {
      clientId,
      amount: 4000,
      currency: 'usd',
      description: 'Missed lesson',
      requestId: 'no-show-1',
    });
    expect(again).toMatchObject({ created: false, charge: { id: charge.id } });
  });

  it('gives the client a payment page when their bank wants them present', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    env.fake.setSavedMethodOutcome('requires_action');
    const { charge } = await env.run<any>('chargeSavedMethod', {
      clientId,
      amount: 4000,
      currency: 'usd',
      description: 'Missed lesson',
    });
    expect(charge).toMatchObject({
      status: 'requires_action',
      failureCode: 'authentication_required',
    });
    expect(charge.url).toMatch(/^https:\/\/pay\.fake\.test\//);
    expect(env.emitted(PaymentEventName.ChargeActionRequired)).toEqual([
      expect.objectContaining({ chargeId: charge.id, url: charge.url }),
    ]);

    // The client pays on that page: the same charge becomes paid.
    const page = [...env.fake.charges.values()].find((c) => c.kind === 'checkout');
    if (!page) throw new Error('no page');
    env.fake.payCharge(page.id);
    await env.deliver('charge', page.id);
    expect((await env.data.PaymentCharge.findById(charge.id)).status).toBe('paid');
  });

  it('can hold the amount instead of charging it', async () => {
    const env = await seller();
    const { clientId } = await clientWithCard(env);
    const { charge } = await env.run<any>('chargeSavedMethod', {
      clientId,
      amount: 10_000,
      currency: 'usd',
      description: 'Damage deposit',
      capture: 'manual',
    });
    expect(charge.status).toBe('authorized');
    expect(env.emitted(PaymentEventName.ChargeAuthorized)).toHaveLength(1);
    const captured = await env.run<any>('captureCharge', { chargeId: charge.id });
    expect(captured.charge.status).toBe('paid');
  });

  it('refuses clients without a saved method and other sellers’ clients', async () => {
    const env = await seller();
    await env.run('createCharge', {
      amount: 1000,
      currency: 'usd',
      description: 'x',
      client: { reference: 'no-card' },
    });
    const [client] = (await env.run<any>('listClients', {})).clients;
    const none = await env.tryRun('chargeSavedMethod', {
      clientId: client.id,
      amount: 100,
      currency: 'usd',
      description: 'x',
    });
    expect(none.success ? null : none.error.metadata?.reason).toBe(
      'payments_payment_method_required',
    );
    const stranger = await env.tryRun(
      'chargeSavedMethod',
      { clientId: client.id, amount: 100, currency: 'usd', description: 'x' },
      env.as('seller-2'),
    );
    expect(stranger.success).toBe(false);
  });
});
