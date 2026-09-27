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
  it('accepts the checkout, refund, dispute, and v2 account events and nothing else', () => {
    for (const type of [
      'checkout.session.completed',
      'checkout.session.expired',
      'refund.failed',
      'charge.dispute.closed',
      'v2.core.account[requirements].updated',
    ]) {
      expect(isRelevantStripeEvent(type)).toBe(true);
    }
    for (const type of [
      'payout.paid',
      'payment_intent.succeeded',
      'v2.core.account_person.created',
    ]) {
      expect(isRelevantStripeEvent(type)).toBe(false);
    }
  });
});
