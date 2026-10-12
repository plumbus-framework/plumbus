import { describe, expect, it } from 'vitest';
import { isRelevantStripeEvent, verifyStripeWebhook } from '../events.js';
import {
  signStripeWebhook,
  stripeSnapshotEvent,
  stripeThinAccountEvent,
} from '../testing/index.js';
import { checkoutSession } from './fixtures.js';

const verify = (
  delivery: { rawBody: Buffer; headers: Record<string, string> },
  secrets = ['whsec_a'],
) => verifyStripeWebhook({ ...delivery, secrets, toleranceSeconds: 300 });

describe('verifyStripeWebhook', () => {
  it('normalizes a snapshot event from a seller account', () => {
    const payload = stripeSnapshotEvent({
      id: 'evt_snap',
      type: 'checkout.session.completed',
      account: 'acct_seller',
      object: checkoutSession(),
      created: 1_790_000_000,
    });
    const event = verify(signStripeWebhook({ payload, secret: 'whsec_a' }));
    expect(event).toMatchObject({
      eventId: 'evt_snap',
      type: 'checkout.session.completed',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'cs_test_1',
      objectType: 'checkout.session',
    });
    expect(event.occurredAt.toISOString()).toBe(new Date(1_790_000_000 * 1000).toISOString());
  });

  it('normalizes a thin v2 account event, taking the seller from related_object', () => {
    const payload = stripeThinAccountEvent({
      id: 'evt_thin',
      type: 'v2.core.account[configuration.merchant].capability_status_updated',
      accountId: 'acct_seller',
      created: '2026-09-27T10:00:00.000Z',
    });
    const event = verify(signStripeWebhook({ payload, secret: 'whsec_a' }));
    expect(event).toMatchObject({
      eventId: 'evt_thin',
      format: 'thin',
      accountId: 'acct_seller',
      objectId: 'acct_seller',
      objectType: 'v2.core.account',
    });
  });

  it('accepts any configured secret (two destinations, or a rotation in progress)', () => {
    const payload = stripeThinAccountEvent({
      type: 'v2.core.account.updated',
      accountId: 'acct_1',
    });
    const delivery = signStripeWebhook({ payload, secret: 'whsec_second' });
    expect(() => verify(delivery, ['whsec_first'])).toThrow('did not verify');
    expect(verify(delivery, ['whsec_first', 'whsec_second']).type).toBe('v2.core.account.updated');
  });

  it('rejects tampered bodies, stale timestamps, and missing headers', () => {
    const payload = stripeThinAccountEvent({
      type: 'v2.core.account.updated',
      accountId: 'acct_1',
    });
    const delivery = signStripeWebhook({ payload, secret: 'whsec_a' });
    const tampered = {
      ...delivery,
      rawBody: Buffer.from(delivery.rawBody.toString().replace('acct_1', 'acct_2')),
    };
    expect(() => verify(tampered)).toThrow('did not verify');

    const stale = signStripeWebhook({
      payload,
      secret: 'whsec_a',
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(() => verify(stale)).toThrow('did not verify');

    expect(() => verify({ rawBody: delivery.rawBody, headers: {} })).toThrow(
      'Missing Stripe-Signature',
    );
  });

  it('rejects signed bodies that are not Stripe events', () => {
    const delivery = signStripeWebhook({ payload: { object: 'something' }, secret: 'whsec_a' });
    expect(() => verify(delivery)).toThrow('Unrecognized');
  });
});

describe('isRelevantStripeEvent', () => {
  it('accepts the events the adapter resolves and nothing else', () => {
    for (const type of [
      'checkout.session.completed',
      'checkout.session.expired',
      'payment_intent.succeeded',
      'payment_intent.amount_capturable_updated',
      'refund.failed',
      'charge.dispute.closed',
      'payment_method.detached',
      'customer.subscription.updated',
      'invoice.payment_failed',
      'transfer.reversed',
      'payout.paid',
      'entitlements.active_entitlement_summary.updated',
      'v2.core.account[requirements].updated',
      'v2.core.account[configuration.recipient].capability_status_updated',
    ]) {
      expect(isRelevantStripeEvent(type)).toBe(true);
    }
    for (const type of ['customer.created', 'invoice.upcoming', 'v2.core.account_person.created']) {
      expect(isRelevantStripeEvent(type)).toBe(false);
    }
  });
});

describe('verifyStripeWebhook — platform events', () => {
  const deliver = (
    type: string,
    object: Record<string, unknown> & { id: string; object: string },
  ) =>
    verify(
      signStripeWebhook({
        payload: stripeSnapshotEvent({ type, account: null, object }),
        secret: 'whsec_a',
      }),
    );

  it('routes a platform object by the tenant stamped into its metadata', () => {
    const event = deliver('transfer.reversed', {
      id: 'tr_1',
      object: 'transfer',
      metadata: { plumbus_tenant_id: 'tenant-a' },
    });
    expect(event).toMatchObject({ accountId: null, objectId: 'tr_1' });
    expect(event.routing).toEqual({
      tenantId: 'tenant-a',
      customerId: null,
      paymentId: null,
      subscriptionId: null,
    });
  });

  it('routes invoices and payments by their customer, payment, and subscription', () => {
    expect(
      deliver('invoice.paid', {
        id: 'in_1',
        object: 'invoice',
        customer: 'cus_1',
        metadata: {},
        parent: { subscription_details: { subscription: 'sub_1' } },
      }).routing,
    ).toEqual({ tenantId: null, customerId: 'cus_1', paymentId: null, subscriptionId: 'sub_1' });
    expect(
      deliver('payment_intent.succeeded', {
        id: 'pi_1',
        object: 'payment_intent',
        customer: { id: 'cus_2' },
      }).routing,
    ).toMatchObject({ customerId: 'cus_2', paymentId: 'pi_1' });
    expect(
      deliver('customer.subscription.updated', {
        id: 'sub_9',
        object: 'subscription',
        customer: 'cus_3',
      }).routing,
    ).toMatchObject({ customerId: 'cus_3', subscriptionId: 'sub_9' });
  });

  it("takes an entitlement summary's customer as its object (summaries have no id)", () => {
    const payload = stripeSnapshotEvent({
      type: 'entitlements.active_entitlement_summary.updated',
      account: null,
      object: { id: '', object: 'entitlements.active_entitlement_summary', customer: 'cus_7' },
    });
    delete ((payload.data as { object: Record<string, unknown> }).object as { id?: string }).id;
    const event = verify(signStripeWebhook({ payload, secret: 'whsec_a' }));
    expect(event).toMatchObject({
      objectId: 'cus_7',
      objectType: 'entitlements.active_entitlement_summary',
    });
    expect(event.routing.customerId).toBe('cus_7');
  });
});
