// Stripe requests for every charge flow and collection method, holds, saved
// methods, subscriptions, links, transfers, payouts, and disputes — and how
// each Stripe object comes back as neutral state.

import type { ChargeRouting, CreateChargeInput } from '@plumbus/payments';
import { describe, expect, it } from 'vitest';
import { stripeProvider } from '../provider.js';
import { createStripeHttpStub, type RecordedStripeRequest } from '../testing/index.js';
import {
  checkoutSession,
  dispute,
  invoice,
  list,
  paidSession,
  payout,
  paymentIntent,
  paymentMethod,
  price,
  subscription,
  transfer,
} from './fixtures.js';

const direct: ChargeRouting = {
  flow: 'direct',
  sellerAccountId: 'acct_seller',
  onBehalfOf: false,
  transferGroup: null,
};
const destination: ChargeRouting = { ...direct, flow: 'destination' };
const platform: ChargeRouting = {
  flow: 'platform',
  sellerAccountId: null,
  onBehalfOf: false,
  transferGroup: 'order-1',
};

function setup() {
  const stub = createStripeHttpStub();
  const provider = stripeProvider({
    secretKey: 'sk_test_flows',
    webhookSecrets: ['whsec_1', 'whsec_2'],
    publishableKey: 'pk_test_flows',
    maxNetworkRetries: 0,
    httpClient: stub.httpClient,
  });
  const sent = (method: string, path: string) =>
    stub.requests.filter((r) => r.method === method && r.path === path);
  const one = (method: string, path: string): RecordedStripeRequest => {
    const [request] = sent(method, path);
    if (!request) throw new Error(`no ${method} ${path}`);
    return request;
  };
  return { stub, provider, sent, one };
}

function charge(overrides: Partial<CreateChargeInput> = {}): CreateChargeInput {
  return {
    ...direct,
    reference: 'charge-local-1',
    currency: 'usd',
    items: [{ name: 'Lesson', unitAmount: 2500, quantity: 2 }],
    description: 'Two lessons',
    platformFeeAmount: 500,
    ui: 'hosted',
    successUrl: 'https://app.test/paid',
    cancelUrl: 'https://app.test/cancelled',
    returnUrl: 'https://app.test/returned',
    expiresAt: new Date(Date.now() + 3_600_000),
    capture: 'automatic',
    saveMethod: false,
    options: {},
    metadata: { plumbus_charge_id: 'charge-local-1', plumbus_tenant_id: 't1' },
    idempotencyKey: 'plumbus-charge:1',
    ...overrides,
  };
}

describe('charge flows', () => {
  it('puts a destination charge on the platform and pays the seller through transfer_data', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider.createCharge(charge({ ...destination, onBehalfOf: true }));
    const request = one('POST', '/v1/checkout/sessions');
    expect(request.headers['stripe-account']).toBeUndefined();
    expect(request.body).toMatchObject({
      'payment_intent_data[application_fee_amount]': '500',
      'payment_intent_data[transfer_data][destination]': 'acct_seller',
      'payment_intent_data[on_behalf_of]': 'acct_seller',
      'line_items[0][quantity]': '2',
      'line_items[0][price_data][unit_amount]': '2500',
    });
  });

  it('keeps a platform charge on the platform with its transfer group and no fee', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider.createCharge(charge({ ...platform, platformFeeAmount: 0 }));
    const request = one('POST', '/v1/checkout/sessions');
    expect(request.headers['stripe-account']).toBeUndefined();
    expect(request.body['payment_intent_data[transfer_group]']).toBe('order-1');
    expect(request.body['payment_intent_data[application_fee_amount]']).toBeUndefined();
    expect(request.body['payment_intent_data[transfer_data][destination]']).toBeUndefined();
  });

  it('refuses a destination charge without a seller', async () => {
    const { provider } = setup();
    await expect(
      provider.createCharge(charge({ ...destination, sellerAccountId: null })),
    ).rejects.toThrow('needs a seller account');
  });

  it('opens an embedded page and returns its client secret', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () =>
      checkoutSession({ url: null, client_secret: 'cs_test_1_secret_abc' }),
    );
    const result = await provider.createCharge(charge({ ui: 'embedded' }));
    const { body } = one('POST', '/v1/checkout/sessions');
    expect(body).toMatchObject({
      ui_mode: 'embedded_page',
      return_url: 'https://app.test/returned',
    });
    expect(body.success_url).toBeUndefined();
    expect(result).toMatchObject({ clientSecret: 'cs_test_1_secret_abc', url: null });
    expect(provider.publishableKey).toBe('pk_test_flows');
  });

  it('passes page options, holds, and saving the method', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider.createCharge(
      charge({
        clientId: 'cus_1',
        capture: 'manual',
        saveMethod: true,
        options: {
          allowPromotionCodes: true,
          automaticTax: true,
          billingAddress: 'required',
          phone: true,
          shippingCountries: ['US', 'CA'],
          locale: 'fr',
          submitType: 'book',
          statementDescriptorSuffix: 'LESSON',
        },
      }),
    );
    expect(one('POST', '/v1/checkout/sessions').body).toMatchObject({
      customer: 'cus_1',
      allow_promotion_codes: 'true',
      'automatic_tax[enabled]': 'true',
      'customer_update[address]': 'auto',
      billing_address_collection: 'required',
      'phone_number_collection[enabled]': 'true',
      'shipping_address_collection[allowed_countries][0]': 'US',
      'shipping_address_collection[allowed_countries][1]': 'CA',
      locale: 'fr',
      submit_type: 'book',
      'payment_intent_data[capture_method]': 'manual',
      'payment_intent_data[setup_future_usage]': 'off_session',
      'payment_intent_data[statement_descriptor_suffix]': 'LESSON',
    });
  });

  it('makes a customer for a method saved without a client', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider.createCharge(charge({ saveMethod: true }));
    expect(one('POST', '/v1/checkout/sessions').body.customer_creation).toBe('always');
  });

  it('lets the client choose the amount through a price made for the charge', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/prices', () => price({ id: 'price_custom', recurring: null }));
    stub.on('POST /v1/checkout/sessions', () => checkoutSession());
    await provider.createCharge(
      charge({
        items: [{ name: 'Tip', unitAmount: 0, quantity: 1 }],
        customAmount: { minimum: 500, preset: 1500, maximum: 10_000 },
      }),
    );
    const priceRequest = one('POST', '/v1/prices');
    expect(priceRequest.headers['stripe-account']).toBe('acct_seller');
    expect(priceRequest.headers['idempotency-key']).toBe('plumbus-charge:1:price');
    expect(priceRequest.body).toMatchObject({
      'custom_unit_amount[enabled]': 'true',
      'custom_unit_amount[minimum]': '500',
      'custom_unit_amount[preset]': '1500',
      'custom_unit_amount[maximum]': '10000',
      'product_data[name]': 'Tip',
    });
    expect(one('POST', '/v1/checkout/sessions').body).toMatchObject({
      'line_items[0][price]': 'price_custom',
      'line_items[0][quantity]': '1',
    });
  });

  it('maps discounts, tax, holds, and saved methods from a completed page', async () => {
    const { provider } = setup();
    const { mapSession } = await import('../mapping.js');
    const held = mapSession(
      paidSession({
        payment_status: 'unpaid',
        amount_subtotal: 10_000,
        amount_total: 8640,
        total_details: { amount_discount: 2000, amount_tax: 640 },
        payment_intent: paymentIntent({
          status: 'requires_capture',
          amount: 8640,
          amount_received: 0,
          amount_capturable: 8640,
          setup_future_usage: 'off_session',
          payment_method: paymentMethod(),
          latest_charge: {
            id: 'ch_1',
            amount_refunded: 0,
            created: 1,
            payment_method_details: { card: { capture_before: 1_790_000_000 } },
          },
        }),
      }),
    );
    expect(held).toMatchObject({
      status: 'authorized',
      amountSubtotal: 10_000,
      amountTotal: 8640,
      amountDiscount: 2000,
      amountTax: 640,
      amountCapturable: 8640,
      captureBefore: new Date(1_790_000_000 * 1000),
      savedMethod: { id: 'pm_1', customerId: 'cus_1', brand: 'visa', last4: '4242' },
    });
    // A partial capture takes less than the page asked for.
    expect(
      mapSession(
        paidSession({
          amount_total: 20_000,
          payment_intent: paymentIntent({ status: 'succeeded', amount_received: 15_000 }),
        }),
      ),
    ).toMatchObject({ status: 'paid', amountTotal: 15_000 });
    // A released hold.
    expect(
      mapSession(paidSession({ payment_intent: paymentIntent({ status: 'canceled' }) })).status,
    ).toBe('canceled');
    void provider;
  });
});

describe('invoices', () => {
  const input = {
    ...direct,
    reference: 'charge-local-1',
    currency: 'usd',
    items: [
      { name: 'Term fees', unitAmount: 10_000, quantity: 1 },
      { name: 'Books', description: 'Printed', unitAmount: 1000, quantity: 2 },
    ],
    description: 'Autumn term',
    platformFeeAmount: 1200,
    clientId: 'cus_1',
    dueInDays: 14,
    automaticTax: false,
    metadata: { plumbus_charge_id: 'charge-local-1' },
    idempotencyKey: 'plumbus-charge:inv',
  };

  it('creates, fills, finalizes, and sends an invoice on the seller account', async () => {
    const { stub, provider, one, sent } = setup();
    stub.on('GET /v1/invoices', () => list([]));
    stub.on('POST /v1/invoices', () => invoice({ status: 'draft', hosted_invoice_url: null }));
    stub.on('POST /v1/invoiceitems', () => ({ id: 'ii_1', object: 'invoiceitem' }));
    stub.on('POST /v1/invoices/*/finalize', () => invoice());
    stub.on('POST /v1/invoices/*/send', () => invoice());
    stub.on('GET /v1/invoices/*', () => invoice());

    const result = await provider.createInvoiceCharge?.(input);
    expect(one('POST', '/v1/invoices').body).toMatchObject({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      days_until_due: '14',
      pending_invoice_items_behavior: 'exclude',
      application_fee_amount: '1200',
      'metadata[plumbus_charge_id]': 'charge-local-1',
    });
    const items = sent('POST', '/v1/invoiceitems');
    expect(
      items.map((r) => [r.body.description, r.body.quantity, r.body.unit_amount_decimal]),
    ).toEqual([
      ['Term fees', '1', '10000'],
      ['Books — Printed', '2', '1000'],
    ]);
    expect(items.every((r) => r.body.invoice === 'in_1')).toBe(true);
    expect(items.every((r) => r.headers['stripe-account'] === 'acct_seller')).toBe(true);
    expect(sent('POST', '/v1/invoices/in_1/send')).toHaveLength(1);
    expect(result).toMatchObject({
      id: 'in_1',
      reference: 'charge-local-1',
      status: 'open',
      url: 'https://invoice.stripe.com/i/in_1',
      amountTotal: 12_000,
      platformFeeAmount: 1200,
    });
  });

  it('finishes an invoice an earlier attempt left as a draft instead of making another', async () => {
    const { stub, provider, sent } = setup();
    stub.on('GET /v1/invoices', () =>
      list([
        invoice({ id: 'in_other', metadata: { plumbus_charge_id: 'someone-else' } }),
        invoice({
          id: 'in_left',
          status: 'draft',
          lines: { object: 'list', data: [{ id: 'il_1' }] },
        }),
      ]),
    );
    stub.on('POST /v1/invoices/*/finalize', () => invoice({ id: 'in_left' }));
    stub.on('GET /v1/invoices/*', () => invoice({ id: 'in_left' }));
    const result = await provider.createInvoiceCharge?.(input);
    expect(sent('POST', '/v1/invoices')).toHaveLength(0);
    // Its items were added before the crash.
    expect(sent('POST', '/v1/invoiceitems')).toHaveLength(0);
    expect(result?.id).toBe('in_left');
  });

  it('bills destination invoices on the platform, paid on to the seller', async () => {
    const { stub, provider, one } = setup();
    stub.on('GET /v1/invoices', () => list([]));
    stub.on('POST /v1/invoices', () => invoice({ status: 'draft' }));
    stub.on('POST /v1/invoiceitems', () => ({ id: 'ii_1', object: 'invoiceitem' }));
    stub.on('POST /v1/invoices/*/finalize', () => invoice());
    stub.on('POST /v1/invoices/*/send', () => invoice());
    stub.on('GET /v1/invoices/*', () => invoice());
    await provider.createInvoiceCharge?.({ ...input, ...destination });
    const request = one('POST', '/v1/invoices');
    expect(request.headers['stripe-account']).toBeUndefined();
    expect(request.body['transfer_data[destination]']).toBe('acct_seller');
  });

  it('maps a paid invoice to a paid charge with its payment', async () => {
    const { mapInvoiceCharge } = await import('../mapping.js');
    expect(
      mapInvoiceCharge(
        invoice({
          status: 'paid',
          status_transitions: { paid_at: 1_789_500_000 },
          total_taxes: [{ amount: 300 }, { amount: 100 }],
          total_discount_amounts: [{ amount: 500 }],
          payments: {
            data: [{ status: 'paid', payment: { payment_intent: 'pi_9' } }],
          },
        }),
      ),
    ).toMatchObject({
      status: 'paid',
      paymentId: 'pi_9',
      amountTax: 400,
      amountDiscount: 500,
      paidAt: new Date(1_789_500_000 * 1000),
      url: null,
    });
  });
});

describe('saved payment methods', () => {
  const input = {
    ...direct,
    reference: 'charge-local-2',
    amount: 4000,
    currency: 'usd',
    description: 'Missed lesson',
    platformFeeAmount: 400,
    clientId: 'cus_1',
    methodId: 'pm_1',
    capture: 'automatic' as const,
    metadata: { plumbus_charge_id: 'charge-local-2' },
    idempotencyKey: 'plumbus-charge:saved',
  };

  it('charges off-session and marks the payment as the charge itself', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/payment_intents', () =>
      paymentIntent({ id: 'pi_saved', metadata: { plumbus_charge_id: 'charge-local-2' } }),
    );
    const result = await provider.chargeSavedMethod?.(input);
    expect(one('POST', '/v1/payment_intents').body).toMatchObject({
      amount: '4000',
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: 'true',
      confirm: 'true',
      application_fee_amount: '400',
      'metadata[plumbus_collection]': 'saved_method',
    });
    expect(result).toMatchObject({ id: 'pi_saved', paymentId: 'pi_saved', status: 'paid' });
  });

  it('turns a bank that wants the client, or a decline, into an outcome', async () => {
    const { stub, provider } = setup();
    let code = 'authentication_required';
    stub.on('POST /v1/payment_intents', () => ({
      status: 402,
      body: {
        error: {
          type: 'card_error',
          code,
          message: 'The card was declined.',
          payment_intent: paymentIntent({
            id: 'pi_declined',
            status: 'requires_payment_method',
            amount_received: 0,
            latest_charge: null,
            metadata: { plumbus_charge_id: 'charge-local-2', plumbus_collection: 'saved_method' },
            last_payment_error: {
              code,
              decline_code: code === 'card_declined' ? 'insufficient_funds' : null,
            },
          }),
        },
      },
    }));
    expect(await provider.chargeSavedMethod?.(input)).toMatchObject({
      id: 'pi_declined',
      status: 'requires_action',
      failureCode: 'authentication_required',
    });
    code = 'card_declined';
    expect(await provider.chargeSavedMethod?.(input)).toMatchObject({
      status: 'failed',
      failureCode: 'insufficient_funds',
    });
  });

  it('saves a card through a setup page and reads it back from the event', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () =>
      checkoutSession({ id: 'cs_setup', mode: 'setup', url: 'https://checkout.stripe.com/setup' }),
    );
    const page = await provider.createSetupSession?.({
      sellerAccountId: 'acct_seller',
      clientId: 'cus_1',
      reference: 'client-1',
      successUrl: 'https://app.test/saved',
      cancelUrl: 'https://app.test/back',
      metadata: { plumbus_client_id: 'client-1' },
      idempotencyKey: 'k',
    });
    expect(one('POST', '/v1/checkout/sessions').body).toMatchObject({
      mode: 'setup',
      customer: 'cus_1',
      'payment_method_types[0]': 'card',
    });
    expect(page).toMatchObject({ id: 'cs_setup', url: 'https://checkout.stripe.com/setup' });

    stub.on('GET /v1/checkout/sessions/*', () =>
      checkoutSession({
        id: 'cs_setup',
        mode: 'setup',
        status: 'complete',
        setup_intent: { id: 'seti_1', payment_method: paymentMethod() },
      }),
    );
    const changes = await provider.resolveEvent({
      eventId: 'e',
      type: 'checkout.session.completed',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'cs_setup',
      objectType: 'checkout.session',
    });
    expect(changes).toEqual([
      {
        kind: 'payment_method',
        accountId: 'acct_seller',
        method: expect.objectContaining({ id: 'pm_1', customerId: 'cus_1', last4: '4242' }),
        detached: false,
      },
    ]);
  });

  it('reports a method as detached once Stripe clears its customer', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/payment_methods/*', () => paymentMethod({ customer: null }));
    const [change] = await provider.resolveEvent({
      eventId: 'e',
      type: 'payment_method.detached',
      format: 'snapshot',
      livemode: false,
      accountId: 'acct_seller',
      objectId: 'pm_1',
      objectType: 'payment_method',
    });
    expect(change).toMatchObject({ kind: 'payment_method', detached: true });
  });

  it('finds the charge a PaymentIntent belongs to, whatever collected it', async () => {
    const { stub, provider } = setup();
    let intent = paymentIntent({
      id: 'pi_saved',
      metadata: { plumbus_charge_id: 'charge-local-2', plumbus_collection: 'saved_method' },
    });
    stub.on('GET /v1/payment_intents/*', () => intent);
    stub.on('GET /v1/checkout/sessions', () => list([]));
    stub.on('GET /v1/invoice_payments', () =>
      list([{ id: 'inpay_1', object: 'invoice_payment', invoice: 'in_1' }]),
    );
    stub.on('GET /v1/invoices/*', () => invoice({ status: 'paid' }));
    const resolve = () =>
      provider.resolveEvent({
        eventId: 'e',
        type: 'payment_intent.succeeded',
        format: 'snapshot',
        livemode: false,
        accountId: null,
        objectId: intent.id,
        objectType: 'payment_intent',
      });

    expect((await resolve())[0]).toMatchObject({
      kind: 'charge',
      accountId: null,
      charge: { id: 'pi_saved', reference: 'charge-local-2' },
    });
    // An invoice's payment carries no metadata of ours; the invoice does.
    intent = paymentIntent({
      id: 'pi_inv',
      metadata: {},
      latest_charge: { id: 'ch_2', amount_refunded: 300, created: 1 },
    });
    expect((await resolve())[0]).toMatchObject({
      charge: { id: 'in_1', paymentId: 'pi_inv', status: 'paid', amountRefunded: 300 },
    });
    expect(stub.requests.every((r) => r.headers['stripe-account'] === undefined)).toBe(true);
  });
});

describe('holds and canceling', () => {
  it('captures part of a hold with the fee recomputed', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/payment_intents/*/capture', () =>
      paymentIntent({ amount: 20_000, amount_received: 15_000, application_fee_amount: 1500 }),
    );
    const result = await provider.captureCharge?.({
      routing: direct,
      paymentId: 'pi_1',
      amount: 15_000,
      platformFeeAmount: 1500,
      idempotencyKey: 'plumbus-capture:1',
    });
    expect(one('POST', '/v1/payment_intents/pi_1/capture').body).toMatchObject({
      amount_to_capture: '15000',
      application_fee_amount: '1500',
    });
    expect(result).toMatchObject({ status: 'paid', amountTotal: 15_000, platformFeeAmount: 1500 });
  });

  it('expires an open page, releases a completed hold, voids an invoice, and cancels a saved-method payment', async () => {
    const { stub, provider, sent } = setup();
    let session = checkoutSession();
    stub.on('GET /v1/checkout/sessions/*', () => session);
    stub.on('POST /v1/checkout/sessions/*/expire', () => checkoutSession({ status: 'expired' }));
    stub.on('GET /v1/payment_intents/*', () => paymentIntent({ status: 'requires_capture' }));
    stub.on('POST /v1/payment_intents/*/cancel', () => paymentIntent({ status: 'canceled' }));
    let invoiceStatus = 'open';
    stub.on('GET /v1/invoices/*', () => invoice({ status: invoiceStatus }));
    stub.on('POST /v1/invoices/*/void', () => {
      invoiceStatus = 'void';
      return invoice({ status: 'void' });
    });

    const base = { routing: direct, paymentId: null };
    expect(
      (await provider.cancelCharge?.({ ...base, collection: 'checkout', chargeId: 'cs_test_1' }))
        ?.status,
    ).toBe('expired');

    session = paidSession({ payment_intent: paymentIntent({ status: 'requires_capture' }) });
    await provider.cancelCharge?.({
      ...base,
      collection: 'checkout',
      chargeId: 'cs_test_1',
      paymentId: 'pi_1',
    });
    expect(sent('POST', '/v1/payment_intents/pi_1/cancel')).toHaveLength(1);

    expect(
      (await provider.cancelCharge?.({ ...base, collection: 'invoice', chargeId: 'in_1' }))?.status,
    ).toBe('canceled');
    expect(sent('POST', '/v1/invoices/in_1/void')).toHaveLength(1);

    const released = await provider.cancelCharge?.({
      ...base,
      collection: 'saved_method',
      chargeId: 'pi_1',
      paymentId: 'pi_1',
    });
    expect(released?.status).toBe('canceled');
    expect(sent('POST', '/v1/payment_intents/pi_1/cancel')).toHaveLength(2);
  });
});

describe('subscriptions', () => {
  const base = {
    ...direct,
    reference: 'sub-local-1',
    clientId: 'cus_1',
    currency: 'usd',
    ui: 'hosted' as const,
    successUrl: 'https://app.test/subscribed',
    cancelUrl: 'https://app.test/back',
    returnUrl: 'https://app.test/returned',
    expiresAt: new Date(Date.now() + 3_600_000),
    options: {},
    metadata: { plumbus_subscription_id: 'sub-local-1' },
    idempotencyKey: 'plumbus-subscription:1',
  };

  it('opens a subscription checkout with inline prices, a trial, and the platform percentage', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () =>
      checkoutSession({ id: 'cs_sub', mode: 'subscription' }),
    );
    const page = await provider.createSubscriptionCheckout?.({
      ...base,
      items: [
        {
          inline: {
            name: 'Weekly tutoring',
            unitAmount: 8000,
            interval: 'month',
            intervalCount: 1,
          },
        },
      ],
      trialDays: 7,
      applicationFeePercent: 7.5,
    });
    const request = one('POST', '/v1/checkout/sessions');
    expect(request.headers['stripe-account']).toBe('acct_seller');
    expect(request.body).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: 'sub-local-1',
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][unit_amount]': '8000',
      'subscription_data[application_fee_percent]': '7.5',
      'subscription_data[trial_period_days]': '7',
      'subscription_data[metadata][plumbus_subscription_id]': 'sub-local-1',
    });
    expect(page).toMatchObject({ id: 'cs_sub' });
  });

  it('finds catalog prices by lookup key and bills metered ones without a quantity', async () => {
    const { stub, provider, one } = setup();
    stub.on('GET /v1/prices', () =>
      list([
        price({ id: 'price_team', lookup_key: 'plumbus:app:team:monthly' }),
        price({ id: 'price_tokens', lookup_key: 'plumbus:app:meter:aiTokens' }),
      ]),
    );
    stub.on('POST /v1/checkout/sessions', () =>
      checkoutSession({ id: 'cs_sub', mode: 'subscription' }),
    );
    await provider.createSubscriptionCheckout?.({
      ...base,
      ...platform,
      transferGroup: null,
      items: [
        { lookupKey: 'plumbus:app:team:monthly', quantity: 3 },
        { lookupKey: 'plumbus:app:meter:aiTokens' },
      ],
    });
    const lookup = one('GET', '/v1/prices');
    expect([lookup.query.get('lookup_keys[0]'), lookup.query.get('lookup_keys[1]')]).toEqual([
      'plumbus:app:team:monthly',
      'plumbus:app:meter:aiTokens',
    ]);
    const { body, headers } = one('POST', '/v1/checkout/sessions');
    expect(headers['stripe-account']).toBeUndefined();
    expect(body).toMatchObject({
      'line_items[0][price]': 'price_team',
      'line_items[0][quantity]': '3',
      'line_items[1][price]': 'price_tokens',
    });
    expect(body['line_items[1][quantity]']).toBeUndefined();
    expect(body['subscription_data[application_fee_percent]']).toBeUndefined();
  });

  it('says to sync the catalog when a lookup key has no price', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/prices', () => list([]));
    await expect(
      provider.createSubscriptionCheckout?.({ ...base, items: [{ lookupKey: 'plumbus:app:x:y' }] }),
    ).rejects.toThrow('run plumbus payments catalog sync');
  });

  it('pays destination subscriptions on to the seller', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/checkout/sessions', () => checkoutSession({ mode: 'subscription' }));
    await provider.createSubscriptionCheckout?.({
      ...base,
      ...destination,
      onBehalfOf: true,
      items: [{ inline: { name: 'Plan', unitAmount: 1000, interval: 'month', intervalCount: 1 } }],
      applicationFeePercent: 10,
    });
    expect(one('POST', '/v1/checkout/sessions').body).toMatchObject({
      'subscription_data[transfer_data][destination]': 'acct_seller',
      'subscription_data[on_behalf_of]': 'acct_seller',
      'subscription_data[application_fee_percent]': '10',
    });
  });

  it('turns checkout, subscription, and invoice events into state', async () => {
    const { stub, provider } = setup();
    let session = checkoutSession({
      id: 'cs_sub',
      mode: 'subscription',
      status: 'complete',
      subscription: 'sub_1',
    });
    stub.on('GET /v1/checkout/sessions/*', () => session);
    stub.on('GET /v1/subscriptions/*', () => subscription());
    stub.on('GET /v1/invoices/*', () =>
      invoice({
        metadata: {},
        billing_reason: 'subscription_cycle',
        attempt_count: 1,
        parent: { subscription_details: { subscription: 'sub_1' } },
      }),
    );
    const event = (type: string, objectId: string, objectType: string) =>
      provider.resolveEvent({
        eventId: 'e',
        type,
        format: 'snapshot',
        livemode: false,
        accountId: 'acct_seller',
        objectId,
        objectType,
      });

    const [started] = await event('checkout.session.completed', 'cs_sub', 'checkout.session');
    expect(started).toMatchObject({
      kind: 'subscription',
      subscription: {
        id: 'sub_1',
        reference: 'sub-local-1',
        status: 'active',
        currentPeriodEnd: new Date(1_791_000_000 * 1000),
        applicationFeePercent: 7.5,
        items: [
          { id: 'si_1', priceId: 'price_1', name: 'Weekly tutoring', quantity: 1, metered: false },
        ],
      },
    });

    session = checkoutSession({ id: 'cs_sub', mode: 'subscription', status: 'expired' });
    expect(await event('checkout.session.expired', 'cs_sub', 'checkout.session')).toEqual([
      {
        kind: 'subscription_checkout_expired',
        accountId: 'acct_seller',
        checkoutId: 'cs_sub',
        reference: 'charge-local-1',
      },
    ]);

    const renewal = await event('invoice.payment_failed', 'in_1', 'invoice');
    expect(renewal.map((c) => c.kind)).toEqual(['subscription', 'invoice']);
    expect(renewal[1]).toMatchObject({
      invoice: { subscriptionId: 'sub_1', attemptCount: 1, billingReason: 'subscription_cycle' },
    });
  });

  it('changes items by lookup key with proration, and cancels at period end or now', async () => {
    const { stub, provider, one } = setup();
    stub.on('GET /v1/prices', () =>
      list([price({ id: 'price_yearly', lookup_key: 'plumbus:app:team:yearly' })]),
    );
    stub.on('POST /v1/subscriptions/*', () => subscription());
    stub.on('DELETE /v1/subscriptions/*', () => subscription({ status: 'canceled' }));
    await provider.updateSubscription?.({
      sellerAccountId: null,
      subscriptionId: 'sub_1',
      items: [{ itemId: 'si_1', lookupKey: 'plumbus:app:team:yearly', quantity: 4 }],
      prorate: true,
      idempotencyKey: 'k1',
    });
    expect(one('POST', '/v1/subscriptions/sub_1').body).toMatchObject({
      'items[0][id]': 'si_1',
      'items[0][price]': 'price_yearly',
      'items[0][quantity]': '4',
      proration_behavior: 'create_prorations',
    });
    await provider.cancelSubscription?.({
      sellerAccountId: null,
      subscriptionId: 'sub_1',
      atPeriodEnd: true,
      idempotencyKey: 'k2',
    });
    expect(stub.requests.at(-1)?.body.cancel_at_period_end).toBe('true');
    const now = await provider.cancelSubscription?.({
      sellerAccountId: null,
      subscriptionId: 'sub_1',
      atPeriodEnd: false,
      idempotencyKey: 'k3',
    });
    expect(stub.requests.at(-1)?.method).toBe('DELETE');
    expect(now?.status).toBe('canceled');
  });
});

describe('payment links', () => {
  it('creates a link with adjustable quantities, a fixed fee, and a redirect', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/payment_links', () => ({
      id: 'plink_1',
      object: 'payment_link',
      url: 'https://buy.stripe.com/test_1',
      active: true,
    }));
    const link = await provider.createPaymentLink?.({
      ...direct,
      reference: 'link-local-1',
      currency: 'usd',
      items: [
        {
          name: 'Group class',
          unitAmount: 1500,
          quantity: 1,
          adjustableQuantity: { minimum: 1, maximum: 5 },
        },
      ],
      platformFeeAmount: 150,
      options: { allowPromotionCodes: true },
      completedUrl: 'https://app.test/thanks',
      metadata: { plumbus_link_id: 'link-local-1' },
    });
    const request = one('POST', '/v1/payment_links');
    expect(request.headers['stripe-account']).toBe('acct_seller');
    expect(request.headers['idempotency-key']).toBe('plumbus-link:link-local-1');
    expect(request.body).toMatchObject({
      'line_items[0][price_data][unit_amount]': '1500',
      'line_items[0][price_data][product_data][name]': 'Group class',
      'line_items[0][adjustable_quantity][enabled]': 'true',
      'line_items[0][adjustable_quantity][maximum]': '5',
      application_fee_amount: '150',
      'after_completion[type]': 'redirect',
      'after_completion[redirect][url]': 'https://app.test/thanks',
      allow_promotion_codes: 'true',
      'metadata[plumbus_link_id]': 'link-local-1',
      'payment_intent_data[metadata][plumbus_link_id]': 'link-local-1',
    });
    expect(link).toEqual({ id: 'plink_1', url: 'https://buy.stripe.com/test_1', active: true });
  });

  it('maps a payment through a link to a charge that names the link', async () => {
    const { mapSession } = await import('../mapping.js');
    expect(
      mapSession(
        paidSession({
          client_reference_id: null,
          metadata: { plumbus_link_id: 'l' },
          payment_link: 'plink_1',
        }),
      ),
    ).toMatchObject({ linkId: 'plink_1', reference: null, status: 'paid' });
  });
});

describe('transfers and payouts', () => {
  it('ties a transfer to the payment it pays out of', async () => {
    const { stub, provider, one } = setup();
    stub.on('GET /v1/payment_intents/*', () => paymentIntent({ latest_charge: 'ch_source' }));
    stub.on('POST /v1/transfers', () => transfer());
    const result = await provider.createTransfer?.({
      destinationAccountId: 'acct_seller',
      amount: 4000,
      currency: 'usd',
      transferGroup: 'order-1',
      sourcePaymentId: 'pi_1',
      reference: 'transfer-local-1',
      metadata: { plumbus_transfer_id: 'transfer-local-1' },
      idempotencyKey: 'plumbus-transfer:1',
    });
    expect(one('POST', '/v1/transfers').body).toMatchObject({
      destination: 'acct_seller',
      amount: '4000',
      transfer_group: 'order-1',
      source_transaction: 'ch_source',
      'metadata[plumbus_source_payment_id]': 'pi_1',
    });
    expect(result).toMatchObject({
      reference: 'transfer-local-1',
      destinationAccountId: 'acct_seller',
    });
  });

  it('reverses a transfer and reads it back', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/transfers/*/reversals', () => ({ id: 'trr_1', object: 'transfer_reversal' }));
    stub.on('GET /v1/transfers/*', () => transfer({ amount_reversed: 1000 }));
    const result = await provider.reverseTransfer?.({
      transferId: 'tr_1',
      amount: 1000,
      metadata: {},
      idempotencyKey: 'k',
    });
    expect(one('POST', '/v1/transfers/tr_1/reversals').body.amount).toBe('1000');
    expect(result?.amountReversed).toBe(1000);
  });

  it('manages payout schedules through Balance Settings and pays out instantly', async () => {
    const { stub, provider, one } = setup();
    const settings = {
      object: 'balance_settings',
      payments: {
        payouts: {
          schedule: { interval: 'weekly', weekly_payout_days: ['friday'] },
          status: 'enabled',
        },
        settlement_timing: { delay_days: 7, delay_days_override: 7 },
      },
    };
    stub.on('POST /v1/balance_settings', () => settings);
    stub.on('GET /v1/balance_settings', () => settings);
    stub.on('GET /v1/balance', () => ({
      object: 'balance',
      available: [],
      pending: [],
      instant_available: [{ amount: 2500, currency: 'usd' }],
    }));
    stub.on('POST /v1/payouts', () => payout({ method: 'instant', status: 'pending' }));

    const updated = await provider.updatePayoutSchedule?.({
      accountId: 'acct_seller',
      schedule: { interval: 'weekly', weeklyAnchor: 'friday', delayDays: 7 },
    });
    const request = one('POST', '/v1/balance_settings');
    expect(request.headers['stripe-account']).toBe('acct_seller');
    expect(request.body).toMatchObject({
      'payments[payouts][schedule][interval]': 'weekly',
      'payments[payouts][schedule][weekly_payout_days][0]': 'friday',
      'payments[settlement_timing][delay_days_override]': '7',
    });
    expect(updated).toEqual({
      schedule: { interval: 'weekly', weeklyAnchor: 'friday', delayDays: 7 },
      instantAvailable: true,
    });

    await provider.updatePayoutSchedule?.({
      accountId: 'acct_seller',
      schedule: { interval: 'daily', delayDays: 'minimum' },
    });
    expect(
      stub.requests.filter((r) => r.path === '/v1/balance_settings').at(-1)?.body,
    ).toMatchObject({ 'payments[settlement_timing][delay_days_override]': '' });

    const instant = await provider.createPayout?.({
      accountId: 'acct_seller',
      amount: 2500,
      currency: 'usd',
      method: 'instant',
      metadata: {},
      idempotencyKey: 'plumbus-payout:1',
    });
    expect(one('POST', '/v1/payouts').body.method).toBe('instant');
    expect(instant).toMatchObject({ method: 'instant', status: 'pending' });
  });

  it("resolves transfer events on the platform and payout events on the seller's account", async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/transfers/*', () => transfer({ amount_reversed: 500 }));
    stub.on('GET /v1/payouts/*', () =>
      payout({ status: 'failed', failure_code: 'account_closed' }),
    );
    const base = { eventId: 'e', format: 'snapshot' as const, livemode: false };
    expect(
      await provider.resolveEvent({
        ...base,
        type: 'transfer.reversed',
        accountId: null,
        objectId: 'tr_1',
        objectType: 'transfer',
      }),
    ).toEqual([
      { kind: 'transfer', transfer: expect.objectContaining({ id: 'tr_1', amountReversed: 500 }) },
    ]);
    expect(
      await provider.resolveEvent({
        ...base,
        type: 'payout.failed',
        accountId: 'acct_seller',
        objectId: 'po_1',
        objectType: 'payout',
      }),
    ).toEqual([
      {
        kind: 'payout',
        accountId: 'acct_seller',
        payout: expect.objectContaining({ status: 'failed', failureCode: 'account_closed' }),
      },
    ]);
    const payoutRead = stub.requests.find((r) => r.path === '/v1/payouts/po_1');
    expect(payoutRead?.headers['stripe-account']).toBe('acct_seller');
  });
});

describe('disputes', () => {
  it('submits text evidence into the disclosure fields and accepts disputes', async () => {
    const { stub, provider, one } = setup();
    stub.on('POST /v1/disputes/*', () =>
      dispute({ status: 'under_review', evidence_details: { due_by: 1, submission_count: 1 } }),
    );
    stub.on('POST /v1/disputes/*/close', () => dispute({ status: 'lost' }));
    const answered = await provider.updateDispute?.({
      sellerAccountId: 'acct_seller',
      disputeId: 'dp_1',
      evidence: {
        productDescription: 'A one-hour lesson',
        customerEmail: 'parent@example.com',
        refundPolicy: 'Refunds up to 24h before',
      },
      submit: true,
    });
    expect(one('POST', '/v1/disputes/dp_1').body).toMatchObject({
      'evidence[product_description]': 'A one-hour lesson',
      'evidence[customer_email_address]': 'parent@example.com',
      'evidence[refund_policy_disclosure]': 'Refunds up to 24h before',
      submit: 'true',
    });
    expect(answered).toMatchObject({ status: 'under_review', evidenceSubmitted: true });
    const accepted = await provider.acceptDispute?.({ sellerAccountId: null, disputeId: 'dp_1' });
    expect(accepted?.status).toBe('lost');
    expect(one('POST', '/v1/disputes/dp_1/close').headers['stripe-account']).toBeUndefined();
  });
});
