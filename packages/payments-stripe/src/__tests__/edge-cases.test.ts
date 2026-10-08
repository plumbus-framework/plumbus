// Edge cases in the Stripe adapter: fields Stripe leaves out, Stripe's limits,
// and destinations left over from an earlier setup.

import { executeCapability } from '@plumbus/core';
import { createPayments } from '@plumbus/payments';
import { createPaymentsTestContext, deliverTestWebhook } from '@plumbus/payments/testing';
import { describe, expect, it } from 'vitest';
import { STRIPE_SNAPSHOT_EVENTS, STRIPE_THIN_EVENTS } from '../events.js';
import { mapSession } from '../mapping.js';
import { STRIPE_API_VERSION, STRIPE_DESTINATION_NAMES, stripeProvider } from '../provider.js';
import {
  createStripeHttpStub,
  type StripeHttpStub,
  signStripeWebhook,
  stripeSnapshotEvent,
} from '../testing/index.js';
import { activeV2Account, checkoutSession, list, paidSession, refund } from './fixtures.js';

const direct = {
  flow: 'direct' as const,
  sellerAccountId: 'acct_seller',
  onBehalfOf: false,
  transferGroup: null,
};

const chargeInput = {
  ...direct,
  reference: 'charge-local-1',
  currency: 'usd',
  items: [{ name: 'Lesson', unitAmount: 1000, quantity: 1 }],
  description: 'Lesson',
  platformFeeAmount: 0,
  ui: 'hosted' as const,
  successUrl: 'https://app.test/paid',
  cancelUrl: 'https://app.test/cancelled',
  returnUrl: 'https://app.test/returned',
  capture: 'automatic' as const,
  saveMethod: false,
  options: {},
  metadata: {},
};

function provider(stub: StripeHttpStub) {
  return stripeProvider({
    secretKey: 'sk_test_edge',
    webhookSecrets: ['whsec_snapshot', 'whsec_thin'],
    httpClient: stub.httpClient,
    maxNetworkRetries: 0,
  });
}

async function stripeApp(stub: StripeHttpStub) {
  stub
    .on('POST /v2/core/accounts', () => activeV2Account())
    .on('GET /v2/core/accounts/*', () => activeV2Account())
    .on('POST /v2/core/account_links', () => ({
      object: 'v2.core.account_link',
      account: 'acct_seller',
      url: 'https://connect.stripe.com/setup/e/acct_seller/x',
      expires_at: '2030-01-01T00:00:00.000Z',
      created: '2029-12-31T23:55:00.000Z',
      livemode: false,
      use_case: { type: 'account_onboarding' },
    }));
  const payments = createPayments({
    provider: provider(stub),
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
    time: { now: () => new Date() },
    auth: { userId: 'tutor-1', tenantId: 'school-1', roles: ['tutor'] },
  });
  const run = async (name: keyof typeof payments.capabilities, input: unknown) => {
    const result = await executeCapability(payments.capabilities[name] as any, ctx, input);
    if (!result.success) throw result.error;
    return result.data as any;
  };
  await run('startMerchantOnboarding', {});
  return { payments, ctx, run };
}

function sentBody(stub: StripeHttpStub, path: string, index = 0) {
  const request = stub.requests.filter((r) => r.path === path)[index];
  if (!request) throw new Error(`no request to ${path}`);
  return request.body;
}

describe('Stripe adapter edge cases', () => {
  it('keeps the platform fee when a session expires before it has a payment intent', async () => {
    const stub = createStripeHttpStub();
    let reference = '';
    let expired = false;
    stub
      .on('POST /v1/checkout/sessions', (request) => {
        reference = String(request.body.client_reference_id);
        return checkoutSession({ client_reference_id: reference, amount_total: 4000 });
      })
      .on('GET /v1/checkout/sessions/*', () =>
        checkoutSession({
          client_reference_id: reference,
          amount_total: 4000,
          ...(expired ? { status: 'expired', url: null } : {}),
        }),
      );
    const app = await stripeApp(stub);
    const { charge } = await app.run('createCharge', {
      amount: 4000,
      currency: 'usd',
      description: 'Algebra tutoring',
    });
    expect(charge.platformFeeAmount).toBe(200);

    expired = true;
    const delivery = signStripeWebhook({
      payload: stripeSnapshotEvent({
        type: 'checkout.session.expired',
        account: 'acct_seller',
        object: checkoutSession({ client_reference_id: reference, status: 'expired' }),
      }),
      secret: 'whsec_snapshot',
    });
    expect((await deliverTestWebhook(app.payments, app.ctx, delivery)).status).toBe('received');

    const stored = await app.run('getCharge', { chargeId: charge.id });
    expect(stored.charge).toMatchObject({ status: 'expired', platformFeeAmount: 200 });
  });

  it('sends a well-formed product name when the item name is cut inside an emoji', async () => {
    const stub = createStripeHttpStub();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider(stub).createCharge({
      ...chargeInput,
      items: [
        {
          name: `${'a'.repeat(249)}😀 and the rest of a long name`,
          unitAmount: 1000,
          quantity: 1,
        },
      ],
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: 'plumbus-charge:emoji',
    });
    const name = String(
      sentBody(stub, '/v1/checkout/sessions')['line_items[0][price_data][product_data][name]'],
    );
    expect(name.startsWith('a'.repeat(249))).toBe(true);
    expect(name).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(name).not.toContain('\uFFFD');
  });

  it("keeps expires_at safely inside Stripe's 30-minute to 24-hour window", async () => {
    const stub = createStripeHttpStub();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    const stripe = provider(stub);
    const now = Math.floor(Date.now() / 1000);

    // Stripe measures from when it creates the session, after the request's travel time.
    await stripe.createCharge({
      ...chargeInput,
      description: 'Shortest allowed',
      expiresAt: new Date((now + 30 * 60) * 1000),
      idempotencyKey: 'plumbus-charge:short',
    });
    await stripe.createCharge({
      ...chargeInput,
      description: 'Longest allowed',
      expiresAt: new Date((now + 24 * 3600) * 1000),
      idempotencyKey: 'plumbus-charge:long',
    });
    const shortest = Number(sentBody(stub, '/v1/checkout/sessions', 0).expires_at);
    const longest = Number(sentBody(stub, '/v1/checkout/sessions', 1).expires_at);
    expect(shortest).toBeGreaterThanOrEqual(now + 30 * 60 + 60);
    expect(longest).toBeLessThanOrEqual(now + 24 * 3600 - 60);
  });

  it('doctor checks the destination at the given URL when an older one shares its name', async () => {
    const stub = createStripeHttpStub();
    const snapshot = {
      object: 'v2.core.event_destination',
      name: STRIPE_DESTINATION_NAMES.snapshot,
      event_payload: 'snapshot',
      status: 'enabled',
      enabled_events: [...STRIPE_SNAPSHOT_EVENTS],
      events_from: ['@self', '@accounts'],
      snapshot_api_version: STRIPE_API_VERSION,
    };
    stub.on('GET /v2/core/accounts', () => ({ data: [], next_page_url: null }));
    stub.on('GET /v2/core/event_destinations', () =>
      list([
        { ...snapshot, id: 'ed_old', webhook_endpoint: { url: 'https://old.test/hook' } },
        {
          ...snapshot,
          id: 'ed_new',
          webhook_endpoint: { url: 'https://app.test/payments/webhooks/stripe' },
        },
        {
          ...snapshot,
          id: 'ed_thin',
          name: STRIPE_DESTINATION_NAMES.thin,
          event_payload: 'thin',
          enabled_events: [...STRIPE_THIN_EVENTS],
          events_from: ['@self'],
          snapshot_api_version: null,
          webhook_endpoint: { url: 'https://app.test/payments/webhooks/stripe' },
        },
      ]),
    );
    const codes = (
      await provider(stub).diagnose?.({ webhookUrl: 'https://app.test/payments/webhooks/stripe' })
    )?.map((f) => f.code);
    expect(codes).not.toContain('stripe_snapshot_destination_url');
    expect(codes).toContain('stripe_snapshot_destination_duplicate');
  });

  it("finds a refund by the local id in its metadata on the seller's account", async () => {
    const stub = createStripeHttpStub();
    stub.on('GET /v1/refunds', () =>
      list([
        refund({ id: 're_other', metadata: { plumbus_refund_id: 'someone-else' } }),
        refund({ id: 're_mine', metadata: { plumbus_refund_id: 'refund-local-7' } }),
      ]),
    );
    const stripe = provider(stub);
    const lookup = { routing: direct, paymentId: 'pi_1' };
    expect(await stripe.findRefund?.({ ...lookup, reference: 'refund-local-7' })).toMatchObject({
      id: 're_mine',
      reference: 'refund-local-7',
    });
    expect(await stripe.findRefund?.({ ...lookup, reference: 'missing' })).toBeNull();
    const [request] = stub.requests;
    expect(request?.headers['stripe-account']).toBe('acct_seller');
    expect(request?.query.get('payment_intent')).toBe('pi_1');
  });

  it('reports fee and refunded amount as unknown when Stripe did not expand them', () => {
    expect(mapSession(checkoutSession({ payment_intent: null }))).toMatchObject({
      platformFeeAmount: null,
      amountRefunded: 0,
    });
    expect(mapSession(paidSession({ payment_intent: 'pi_1' }))).toMatchObject({
      platformFeeAmount: null,
      amountRefunded: null,
    });
    expect(
      mapSession(
        paidSession({
          payment_intent: { id: 'pi_1', application_fee_amount: 250, latest_charge: 'ch_1' },
        }),
      ),
    ).toMatchObject({ platformFeeAmount: 250, amountRefunded: null });
  });
});
