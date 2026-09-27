// Stripe response fixtures shaped like API version 2026-08-26.dahlia.

export function v2Account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct_seller',
    object: 'v2.core.account',
    applied_configurations: ['merchant'],
    created: '2026-09-01T00:00:00.000Z',
    livemode: false,
    dashboard: 'full',
    identity: { country: 'US', entity_type: 'individual' },
    defaults: {
      currency: 'usd',
      responsibilities: {
        fees_collector: 'stripe',
        losses_collector: 'stripe',
        requirements_collector: 'stripe',
      },
    },
    configuration: {
      merchant: {
        applied: true,
        capabilities: {
          card_payments: { status: 'pending', status_details: [] },
          stripe_balance: { payouts: { status: 'pending', status_details: [] } },
        },
      },
    },
    requirements: {
      entries: [
        {
          description: 'Provide a bank account',
          awaiting_action_from: 'user',
          minimum_deadline: { status: 'currently_due' },
          errors: [],
          requested_reasons: [{ code: 'routine_onboarding' }],
        },
      ],
    },
    ...overrides,
  };
}

export function activeV2Account(overrides: Record<string, unknown> = {}) {
  return v2Account({
    configuration: {
      merchant: {
        applied: true,
        capabilities: {
          card_payments: { status: 'active', status_details: [] },
          stripe_balance: { payouts: { status: 'active', status_details: [] } },
        },
      },
    },
    requirements: { entries: [] },
    ...overrides,
  });
}

export function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_1',
    object: 'checkout.session',
    status: 'open',
    payment_status: 'unpaid',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    expires_at: 1_790_000_000,
    amount_total: 5000,
    currency: 'usd',
    livemode: false,
    client_reference_id: 'charge-local-1',
    metadata: { plumbus_charge_id: 'charge-local-1' },
    customer_email: null,
    customer_details: null,
    payment_intent: null,
    ...overrides,
  };
}

export function paidSession(overrides: Record<string, unknown> = {}) {
  return checkoutSession({
    status: 'complete',
    payment_status: 'paid',
    url: null,
    customer_details: { email: 'client@example.com' },
    payment_intent: {
      id: 'pi_1',
      object: 'payment_intent',
      status: 'succeeded',
      application_fee_amount: 250,
      metadata: { plumbus_charge_id: 'charge-local-1' },
      latest_charge: { id: 'ch_1', object: 'charge', amount_refunded: 0, created: 1_789_000_000 },
    },
    ...overrides,
  });
}

export function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: 're_1',
    object: 'refund',
    amount: 1000,
    currency: 'usd',
    status: 'succeeded',
    reason: 'requested_by_customer',
    failure_reason: null,
    metadata: { plumbus_refund_id: 'refund-local-1', plumbus_charge_id: 'charge-local-1' },
    payment_intent: 'pi_1',
    charge: 'ch_1',
    ...overrides,
  };
}

export function dispute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dp_1',
    object: 'dispute',
    amount: 5000,
    currency: 'usd',
    status: 'needs_response',
    reason: 'fraudulent',
    payment_intent: 'pi_1',
    evidence_details: { due_by: 1_790_500_000 },
    ...overrides,
  };
}

export const list = (data: unknown[]) => ({ object: 'list', data, has_more: false, url: '/v1/x' });

export function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    status: 'succeeded',
    amount: 5000,
    amount_received: 5000,
    amount_capturable: 0,
    currency: 'usd',
    livemode: false,
    application_fee_amount: 250,
    customer: 'cus_1',
    metadata: { plumbus_charge_id: 'charge-local-1', plumbus_collection: 'checkout' },
    latest_charge: { id: 'ch_1', object: 'charge', amount_refunded: 0, created: 1_789_000_000 },
    payment_method: 'pm_1',
    last_payment_error: null,
    ...overrides,
  };
}

export function paymentMethod(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pm_1',
    object: 'payment_method',
    type: 'card',
    customer: 'cus_1',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    ...overrides,
  };
}

export function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    object: 'invoice',
    status: 'open',
    currency: 'usd',
    livemode: false,
    customer: 'cus_1',
    customer_email: 'client@example.com',
    metadata: { plumbus_charge_id: 'charge-local-1' },
    subtotal: 12_000,
    total: 12_000,
    amount_due: 12_000,
    amount_paid: 0,
    amount_remaining: 12_000,
    application_fee_amount: 1200,
    total_discount_amounts: [],
    total_taxes: [],
    hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
    invoice_pdf: 'https://invoice.stripe.com/i/in_1/pdf',
    number: 'A-0001',
    due_date: 1_790_600_000,
    period_start: 1_789_000_000,
    period_end: 1_789_000_000,
    billing_reason: 'manual',
    attempt_count: 0,
    status_transitions: { paid_at: null },
    parent: null,
    lines: { object: 'list', data: [], has_more: false },
    payments: { object: 'list', data: [], has_more: false },
    ...overrides,
  };
}

export function price(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price_1',
    object: 'price',
    active: true,
    currency: 'usd',
    lookup_key: null,
    unit_amount: 8000,
    unit_amount_decimal: '8000',
    product: { id: 'prod_1', object: 'product', name: 'Weekly tutoring' },
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
    ...overrides,
  };
}

export function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    currency: 'usd',
    livemode: false,
    customer: 'cus_1',
    metadata: { plumbus_subscription_id: 'sub-local-1' },
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_end: null,
    latest_invoice: 'in_1',
    application_fee_percent: 7.5,
    items: {
      object: 'list',
      data: [{ id: 'si_1', quantity: 1, current_period_end: 1_791_000_000, price: price() }],
    },
    ...overrides,
  };
}

export function transfer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tr_1',
    object: 'transfer',
    amount: 4000,
    amount_reversed: 0,
    currency: 'usd',
    livemode: false,
    destination: 'acct_seller',
    transfer_group: 'order-1',
    metadata: { plumbus_transfer_id: 'transfer-local-1', plumbus_tenant_id: 't1' },
    ...overrides,
  };
}

export function payout(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po_1',
    object: 'payout',
    amount: 9000,
    currency: 'usd',
    status: 'paid',
    method: 'standard',
    arrival_date: 1_790_100_000,
    failure_code: null,
    livemode: false,
    ...overrides,
  };
}
