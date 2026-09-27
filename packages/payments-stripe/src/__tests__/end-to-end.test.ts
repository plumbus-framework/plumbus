// A seller connects, finishes onboarding, charges a client, and gets paid —
// through @plumbus/payments capabilities, this adapter, Stripe-signed webhooks,
// and the same ingest + worker path production runs. Stripe's HTTP API is stubbed.

import { executeCapability } from '@plumbus/core';
import type { MockEventService } from '@plumbus/core/testing';
import { createPayments, PaymentEventName } from '@plumbus/payments';
import { createPaymentsTestContext, deliverTestWebhook } from '@plumbus/payments/testing';
import { describe, expect, it } from 'vitest';
import { stripeProvider } from '../provider.js';
import {
  createStripeHttpStub,
  signStripeWebhook,
  stripeSnapshotEvent,
  stripeThinAccountEvent,
} from '../testing/index.js';
import { activeV2Account, checkoutSession, paidSession, v2Account } from './fixtures.js';

describe('Stripe Connect end to end', () => {
  it('onboards a seller, charges a client with a 5% cut, and records the payment once', async () => {
    const stub = createStripeHttpStub();
    let onboarded = false;
    let paid = false;
    let chargeReference = '';
    stub
      .on('POST /v2/core/accounts', () => v2Account())
      .on('GET /v2/core/accounts/*', () => (onboarded ? activeV2Account() : v2Account()))
      .on('POST /v2/core/account_links', () => ({
        object: 'v2.core.account_link',
        account: 'acct_seller',
        url: 'https://connect.stripe.com/setup/e/acct_seller/x',
        expires_at: '2030-01-01T00:00:00.000Z',
        created: '2029-12-31T23:55:00.000Z',
        livemode: false,
        use_case: { type: 'account_onboarding' },
      }))
      .on('POST /v1/customers', () => ({ id: 'cus_parent', object: 'customer' }))
      .on('POST /v1/checkout/sessions', (request) => {
        chargeReference = String(request.body.client_reference_id);
        return checkoutSession({ client_reference_id: chargeReference, amount_total: 4000 });
      })
      .on('GET /v1/checkout/sessions/*', () =>
        paid
          ? paidSession({
              client_reference_id: chargeReference,
              amount_total: 4000,
              payment_intent: {
                id: 'pi_1',
                status: 'succeeded',
                application_fee_amount: 200,
                latest_charge: { id: 'ch_1', amount_refunded: 0, created: 1_789_000_000 },
              },
            })
          : checkoutSession({ client_reference_id: chargeReference }),
      );

    const payments = createPayments({
      provider: stripeProvider({
        secretKey: 'sk_test_e2e',
        webhookSecrets: ['whsec_snapshot', 'whsec_thin'],
        httpClient: stub.httpClient,
        maxNetworkRetries: 0,
      }),
      seller: { owner: 'user' },
      access: { sellers: { roles: ['tutor'] } },
      dashboards: { full: true },
      countries: { default: 'US' },
      platformFee: { percent: 5 },
      urls: {
        onboardingReturn: 'https://app.test/payments/return',
        onboardingRefresh: 'https://app.test/payments/refresh',
        checkoutSuccess: 'https://app.test/paid/{chargeId}',
        checkoutCancel: 'https://app.test/cancelled/{chargeId}',
      },
    });
    const ctx = createPaymentsTestContext(payments, {
      auth: { userId: 'tutor-1', tenantId: 'school-1', roles: ['tutor'] },
    });
    const events = ctx.events as MockEventService;
    const run = async (name: keyof typeof payments.capabilities, input: unknown) => {
      const result = await executeCapability(payments.capabilities[name] as any, ctx, input);
      if (!result.success) throw result.error;
      return result.data as any;
    };

    const onboarding = await run('startMerchantOnboarding', {});
    expect(onboarding.onboardingUrl).toBe('https://connect.stripe.com/setup/e/acct_seller/x');

    onboarded = true;
    const accountEvent = signStripeWebhook({
      payload: stripeThinAccountEvent({
        type: 'v2.core.account[configuration.merchant].capability_status_updated',
        accountId: 'acct_seller',
      }),
      secret: 'whsec_thin',
    });
    expect((await deliverTestWebhook(payments, ctx, accountEvent)).status).toBe('received');
    expect((await run('getMerchantAccount', {})).merchantAccount.status).toBe('active');

    const { charge } = await run('createCharge', {
      amount: 4000,
      currency: 'usd',
      description: 'Algebra tutoring',
      client: { email: 'parent@example.com' },
    });
    expect(charge.platformFeeAmount).toBe(200);
    const checkoutRequest = stub.requests.find((r) => r.path === '/v1/checkout/sessions');
    expect(checkoutRequest?.headers['stripe-account']).toBe('acct_seller');
    expect(checkoutRequest?.body['payment_intent_data[application_fee_amount]']).toBe('200');

    paid = true;
    const paymentEvent = signStripeWebhook({
      payload: stripeSnapshotEvent({
        id: 'evt_paid_1',
        type: 'checkout.session.completed',
        account: 'acct_seller',
        object: checkoutSession({ client_reference_id: chargeReference }),
      }),
      secret: 'whsec_snapshot',
    });
    const first = await deliverTestWebhook(payments, ctx, paymentEvent);
    const again = await deliverTestWebhook(payments, ctx, paymentEvent);
    expect([first.status, again.status]).toEqual(['received', 'duplicate']);

    const stored = await run('getCharge', { chargeId: charge.id });
    expect(stored.charge).toMatchObject({ status: 'paid', amount: 4000, platformFeeAmount: 200 });
    const paidEvents = events.emitted.filter((e) => e.eventName === PaymentEventName.ChargePaid);
    expect(paidEvents).toHaveLength(1);
    expect(paidEvents[0]?.payload).toMatchObject({ ownerId: 'tutor-1', chargeId: charge.id });

    const forged = {
      ...paymentEvent,
      headers: { ...paymentEvent.headers, 'stripe-signature': 't=1,v1=bad' },
    };
    expect((await deliverTestWebhook(payments, ctx, forged)).status).toBe('rejected');
  });
});
