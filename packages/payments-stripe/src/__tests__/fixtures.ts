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
