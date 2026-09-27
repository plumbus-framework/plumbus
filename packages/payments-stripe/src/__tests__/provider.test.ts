import { describe, expect, it, vi } from 'vitest';
import { STRIPE_API_VERSION, stripeProvider } from '../provider.js';
import { createStripeHttpStub } from '../testing/index.js';
import {
  activeV2Account,
  checkoutSession,
  dispute,
  list,
  paidSession,
  refund,
  v2Account,
} from './fixtures.js';

function setup(key = 'sk_test_123') {
  const stub = createStripeHttpStub();
  const provider = stripeProvider({
    secretKey: key,
    webhookSecrets: ['whsec_a', 'whsec_b'],
    publishableKey: 'pk_test_1',
    maxNetworkRetries: 0,
    httpClient: stub.httpClient,
  });
  return { stub, provider };
}

describe('stripeProvider — sellers (Accounts v2)', () => {
  it('creates a v2 merchant account with the chosen dashboard and responsibilities', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v2/core/accounts', () => v2Account({ dashboard: 'express' }));

    const account = await provider.createMerchantAccount({
      dashboard: 'express',
      feesCollector: 'platform',
      lossesCollector: 'platform',
      country: 'US',
      email: 'seller@example.com',
      displayName: 'Ada Studio',
      metadata: { plumbus_tenant_id: 't1' },
      idempotencyKey: 'plumbus-merchant:t1',
    });

    const [request] = stub.requests;
    expect(request?.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    expect(request?.headers['idempotency-key']).toBe('plumbus-merchant:t1');
    expect(request?.headers['stripe-account']).toBeUndefined();
    expect(request?.body).toMatchObject({
      dashboard: 'express',
      contact_email: 'seller@example.com',
      display_name: 'Ada Studio',
      identity: { country: 'us' },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: {
        responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      },
      metadata: { plumbus_tenant_id: 't1' },
      include: ['configuration.merchant', 'defaults', 'identity', 'requirements'],
    });
    expect(account).toMatchObject({
      id: 'acct_seller',
      dashboard: 'express',
      chargesEnabled: false,
      requirementsDue: ['Provide a bank account'],
    });
  });

  it('creates v2 onboarding links and reads accounts with their requirements', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v2/core/account_links', () => ({
      object: 'v2.core.account_link',
      account: 'acct_seller',
      url: 'https://connect.stripe.com/setup/e/acct_seller/abc',
      expires_at: '2026-09-27T12:00:00.000Z',
      created: '2026-09-27T11:55:00.000Z',
      livemode: false,
      use_case: { type: 'account_onboarding' },
    }));
    stub.on('GET /v2/core/accounts/*', () => activeV2Account());

    const link = await provider.createOnboardingLink({
      accountId: 'acct_seller',
      returnUrl: 'https://app.test/return',
      refreshUrl: 'https://app.test/refresh',
      collectEventuallyDue: true,
    });
    expect(link.expiresAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(stub.requests[0]?.body).toEqual({
      account: 'acct_seller',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url: 'https://app.test/refresh',
          return_url: 'https://app.test/return',
          collection_options: { fields: 'eventually_due' },
        },
      },
    });

    const account = await provider.retrieveMerchantAccount('acct_seller');
    expect(account).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsDue: [],
    });
    const include = stub.requests[1]?.query;
    expect([0, 1, 2, 3].map((i) => include?.get(`include[${i}]`))).toEqual([
      'configuration.merchant',
      'defaults',
      'identity',
      'requirements',
    ]);
  });

  it('mints embedded component sessions with the configured refund/dispute features', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/account_sessions', () => ({
      object: 'account_session',
      account: 'acct_seller',
      client_secret: 'accs_secret_1',
      expires_at: 1_790_000_000,
      livemode: false,
      components: {},
    }));
    const session = await provider.createMerchantSession({
      accountId: 'acct_seller',
      components: ['onboarding', 'payments', 'payouts', 'notifications'],
      allowRefunds: false,
      allowDisputeManagement: true,
    });
    expect(session).toEqual({
      clientSecret: 'accs_secret_1',
      expiresAt: new Date(1_790_000_000 * 1000),
      publishableKey: 'pk_test_1',
    });
    expect(stub.requests[0]?.body).toMatchObject({
      account: 'acct_seller',
      'components[account_onboarding][enabled]': 'true',
      'components[payments][enabled]': 'true',
      'components[payments][features][refund_management]': 'false',
      'components[payments][features][dispute_management]': 'true',
      'components[payouts][enabled]': 'true',
      'components[notification_banner][enabled]': 'true',
    });
  });

  it('links Express sellers to a login link and full sellers to their own dashboard', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/accounts/*/login_links', () => ({
      object: 'login_link',
      url: 'https://connect.stripe.com/express/abc',
      created: 1,
    }));
    expect(
      await provider.createDashboardLink({ accountId: 'acct_seller', dashboard: 'express' }),
    ).toEqual({
      url: 'https://connect.stripe.com/express/abc',
    });
    expect(
      await provider.createDashboardLink({ accountId: 'acct_seller', dashboard: 'full' }),
    ).toEqual({
      url: 'https://dashboard.stripe.com/',
    });
    await expect(
      provider.createDashboardLink({ accountId: 'acct_seller', dashboard: 'none' }),
    ).rejects.toThrow('no Stripe dashboard');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('stripeProvider — charges and refunds (direct charges)', () => {
  it('creates a Checkout session on the seller account with the platform fee', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    const expiresAt = Math.floor(Date.now() / 1000) + 2 * 3600;

    const charge = await provider.createCharge({
      accountId: 'acct_seller',
      reference: 'charge-local-1',
      amount: 5000,
      currency: 'usd',
      description: 'Private lesson',
      platformFeeAmount: 250,
      clientEmail: 'client@example.com',
      successUrl: 'https://app.test/paid/charge-local-1',
      cancelUrl: 'https://app.test/cancel/charge-local-1',
      expiresAt: new Date(expiresAt * 1000),
      metadata: { plumbus_charge_id: 'charge-local-1' },
      idempotencyKey: 'plumbus-charge:charge-local-1',
    });

    const [request] = stub.requests;
    expect(request?.headers['stripe-account']).toBe('acct_seller');
    expect(request?.headers['idempotency-key']).toBe('plumbus-charge:charge-local-1');
    expect(request?.body).toMatchObject({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '5000',
      'line_items[0][price_data][product_data][name]': 'Private lesson',
      customer_email: 'client@example.com',
      client_reference_id: 'charge-local-1',
      'payment_intent_data[application_fee_amount]': '250',
      'payment_intent_data[metadata][plumbus_charge_id]': 'charge-local-1',
      success_url: 'https://app.test/paid/charge-local-1',
      expires_at: String(expiresAt),
    });
    expect(charge).toMatchObject({
      id: 'cs_test_1',
      reference: 'charge-local-1',
      status: 'open',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
  });

  it('omits the application fee when there is no platform cut and uses an existing customer', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider.createCharge({
      accountId: 'acct_seller',
      reference: 'c2',
      amount: 100,
      currency: 'eur',
      description: 'x',
      platformFeeAmount: 0,
      clientId: 'cus_1',
      clientEmail: 'ignored@example.com',
      successUrl: 'https://a.test/s',
      cancelUrl: 'https://a.test/c',
      expiresAt: new Date(),
      metadata: {},
      idempotencyKey: 'k',
    });
    const body = stub.requests[0]?.body ?? {};
    expect(body['payment_intent_data[application_fee_amount]']).toBeUndefined();
    expect(body.customer).toBe('cus_1');
    expect(body.customer_email).toBeUndefined();
  });

  it('creates customers and refunds on the seller account', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/customers', () => ({ id: 'cus_9', object: 'customer' }));
    stub.on('POST /v1/refunds', () => refund({ status: 'pending' }));

    expect(
      await provider.createClient({
        accountId: 'acct_seller',
        email: 'c@example.com',
        name: 'C',
        metadata: {},
        idempotencyKey: 'plumbus-client:1',
      }),
    ).toEqual({ clientId: 'cus_9' });
    const created = await provider.createRefund({
      accountId: 'acct_seller',
      paymentId: 'pi_1',
      reference: 'refund-local-1',
      amount: 1000,
      reason: 'requested_by_customer',
      refundPlatformFee: true,
      metadata: { plumbus_refund_id: 'refund-local-1' },
      idempotencyKey: 'plumbus-refund:1',
    });
    expect(stub.requests.map((r) => r.headers['stripe-account'])).toEqual([
      'acct_seller',
      'acct_seller',
    ]);
    expect(stub.requests[1]?.body).toMatchObject({
      payment_intent: 'pi_1',
      amount: '1000',
      reason: 'requested_by_customer',
      refund_application_fee: 'true',
    });
    expect(created).toMatchObject({ id: 're_1', reference: 'refund-local-1', status: 'pending' });
  });
});

describe('stripeProvider — resolveEvent (fetch-on-event)', () => {
  it('re-reads a v2 account for thin account events', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v2/core/accounts/*', () => activeV2Account());
    const changes = await provider.resolveEvent({
      eventId: 'evt_1',
      type: 'v2.core.account[requirements].updated',
      format: 'thin',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'acct_seller',
      objectType: 'v2.core.account',
    });
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'merchant',
        account: expect.objectContaining({ chargesEnabled: true }),
      }),
    ]);
  });

  it('re-reads the checkout session (with payment + charge) for checkout events', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/checkout/sessions/*', () => paidSession());
    const [change] = await provider.resolveEvent({
      eventId: 'evt_2',
      type: 'checkout.session.completed',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'cs_test_1',
      objectType: 'checkout.session',
    });
    expect(stub.requests[0]?.headers['stripe-account']).toBe('acct_seller');
    expect(stub.requests[0]?.query.get('expand[0]')).toBe('payment_intent.latest_charge');
    expect(change).toEqual({
      kind: 'charge',
      accountId: 'acct_seller',
      charge: expect.objectContaining({
        status: 'paid',
        paymentId: 'pi_1',
        platformFeeAmount: 250,
        clientEmail: 'client@example.com',
        reference: 'charge-local-1',
      }),
    });
  });

  it('returns the refund and the refreshed charge for refund events', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/refunds/*', () => refund());
    stub.on('GET /v1/checkout/sessions', () =>
      list([
        paidSession({
          payment_intent: {
            id: 'pi_1',
            status: 'succeeded',
            application_fee_amount: 250,
            latest_charge: { id: 'ch_1', amount_refunded: 1000, created: 1 },
          },
        }),
      ]),
    );
    const changes = await provider.resolveEvent({
      eventId: 'evt_3',
      type: 'refund.updated',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 're_1',
      objectType: 'refund',
    });
    // The charge first: refunds match the local charge by the payment id it records.
    expect(changes.map((c) => c.kind)).toEqual(['charge', 'refund']);
    expect(changes[1]).toMatchObject({
      chargeReference: 'charge-local-1',
      refund: { status: 'succeeded' },
    });
    expect(changes[0]).toMatchObject({ charge: { amountRefunded: 1000 } });
    expect(stub.requests[1]?.query.get('payment_intent')).toBe('pi_1');
  });

  it('lists refunds of a charge for charge.refunded and ignores payments the app did not create', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/refunds', () => list([refund(), refund({ id: 're_2', amount: 500 })]));
    stub.on('GET /v1/checkout/sessions', () => list([]));
    const changes = await provider.resolveEvent({
      eventId: 'evt_4',
      type: 'charge.refunded',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'ch_1',
      objectType: 'charge',
    });
    expect(changes.map((c) => c.kind)).toEqual(['refund', 'refund']);
    expect(changes.every((c) => c.kind !== 'refund' || c.chargeReference === null)).toBe(true);
  });

  it('returns the charge and the dispute for dispute events', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/disputes/*', () => dispute({ status: 'warning_under_review' }));
    stub.on('GET /v1/checkout/sessions', () => list([paidSession()]));
    const changes = await provider.resolveEvent({
      eventId: 'evt_5',
      type: 'charge.dispute.updated',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'dp_1',
      objectType: 'dispute',
    });
    expect(changes.map((c) => c.kind)).toEqual(['charge', 'dispute']);
    expect(changes[1]).toMatchObject({
      chargeReference: 'charge-local-1',
      dispute: { status: 'under_review', providerStatus: 'warning_under_review' },
    });
  });

  it('returns nothing for events without a seller or object, or of other types', async () => {
    const { stub, provider } = setup();
    const base = { eventId: 'e', format: 'snapshot' as const, livemode: false, objectType: 'x' };
    expect(
      await provider.resolveEvent({
        ...base,
        type: 'payout.paid',
        accountId: 'a',
        objectId: 'po_1',
      }),
    ).toEqual([]);
    expect(
      await provider.resolveEvent({
        ...base,
        type: 'checkout.session.completed',
        accountId: null,
        objectId: 'cs',
      }),
    ).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('stripeProvider — errors', () => {
  it('turns Stripe request errors into validation errors that keep Stripe’s message and codes', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/checkout/sessions', () => ({
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'amount_too_small',
          param: 'line_items[0][price_data][unit_amount]',
          message: "The Checkout Session's total amount due must add up to at least $0.50 usd",
        },
      },
    }));
    const failure = provider
      .createCharge({
        accountId: 'acct_seller',
        reference: 'c',
        amount: 10,
        currency: 'usd',
        description: 'x',
        platformFeeAmount: 0,
        successUrl: 'https://a.test/s',
        cancelUrl: 'https://a.test/c',
        expiresAt: new Date(),
        metadata: {},
        idempotencyKey: 'k',
      })
      .catch((err: unknown) => err);
    const err = (await failure) as {
      code: string;
      message: string;
      metadata: Record<string, unknown>;
    };
    expect(err.code).toBe('validation');
    expect(err.message).toContain('at least $0.50');
    expect(err.metadata).toMatchObject({
      reason: 'stripe_error',
      stripeType: 'StripeInvalidRequestError',
      stripeCode: 'amount_too_small',
      statusCode: 400,
    });
  });

  it('marks Stripe outages as retryable internal errors', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v2/core/accounts/*', () => ({
      status: 500,
      body: { error: { type: 'api_error', message: 'Something went wrong' } },
    }));
    const err = (await provider.retrieveMerchantAccount('acct_x').catch((e: unknown) => e)) as {
      code: string;
      metadata: Record<string, unknown>;
    };
    expect(err.code).toBe('internal');
    expect(err.metadata.retryable).toBe(true);
  });
});

describe('stripeProvider — keys and secrets', () => {
  it('derives live/test mode from the key and never reads secrets at construction', async () => {
    const secretKey = vi.fn(async () => 'rk_live_abc');
    const provider = stripeProvider({ secretKey, webhookSecrets: ['whsec_x'] });
    expect(secretKey).not.toHaveBeenCalled();
    expect(provider.id).toBe('stripe');
    expect(await provider.resolveLivemode()).toBe(true);
    expect(await setup('sk_test_1').provider.resolveLivemode()).toBe(false);
    expect(secretKey).toHaveBeenCalledTimes(1);
  });

  it('rejects keys that are not Stripe secret or restricted keys', async () => {
    const provider = stripeProvider({ secretKey: 'pk_test_1', webhookSecrets: ['whsec_x'] });
    await expect(provider.resolveLivemode()).rejects.toThrow('must start with');
    const missing = stripeProvider({ secretKey: () => '', webhookSecrets: ['whsec_x'] });
    await expect(missing.resolveLivemode()).rejects.toThrow('not configured');
  });

  it('exposes the configured Stripe client for Stripe-only features', async () => {
    const { provider } = setup();
    const client = await provider.client();
    expect(client).toBe(await provider.client());
  });
});
