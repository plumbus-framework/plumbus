# Testing with @plumbus/payments-stripe

Unit tests never call Stripe. For app logic, prefer the neutral fake (`@plumbus/payments/testing`). Use this package's helpers when you need real Stripe signatures or want to assert the requests Stripe would receive.

## Signed events

```ts
import { signStripeWebhook, stripeSnapshotEvent, stripeThinAccountEvent } from '@plumbus/payments-stripe/testing';

const delivery = signStripeWebhook({
  payload: stripeSnapshotEvent({
    type: 'checkout.session.completed',
    account: 'acct_seller',
    object: { id: 'cs_test_1', object: 'checkout.session' },
  }),
  secret: 'whsec_test',
});
// deliverTestWebhook(payments, ctx, delivery) or app.inject({ method: 'POST', url, headers: delivery.headers, payload: delivery.rawBody })
```

`stripeThinAccountEvent({ type: 'v2.core.account.updated', accountId })` builds a thin notification. `signStripeWebhook({ timestamp })` produces stale signatures for negative tests.

## Stubbing Stripe's API

```ts
import { createStripeHttpStub } from '@plumbus/payments-stripe/testing';

const stub = createStripeHttpStub()
  .on('POST /v2/core/accounts', () => ({ id: 'acct_seller', object: 'v2.core.account', livemode: false /* … */ }))
  .on('GET /v1/checkout/sessions/*', () => ({ id: 'cs_test_1', status: 'complete', payment_status: 'paid' /* … */ }))
  .on('POST /v1/refunds', () => ({ status: 400, body: { error: { type: 'invalid_request_error', message: '…' } } }));

const provider = stripeProvider({ secretKey: 'sk_test_x', webhookSecrets: ['whsec_test'], httpClient: stub.httpClient, maxNetworkRetries: 0 });
// stub.requests: method, path, query, headers (stripe-account, idempotency-key, stripe-version), body
```

Unmatched routes answer 404, and the first route that matches answers (register one handler per route and keep changing state in variables). v1 bodies are form fields (`line_items[0][price_data][unit_amount]`); v2 bodies are JSON. Platform requests have no `stripe-account` header; seller requests (direct charges, payouts) do.

## Live test mode (optional, manual)

With a **test** key and the Stripe CLI forwarding (see [webhooks.md](./webhooks.md)): onboard a seller with Stripe's test onboarding data, create a charge, pay with card `4242 4242 4242 4242`, and watch `payments.charge.paid`. Never run this against live keys. In the Plumbus repo, `examples/payments-connect-app` runs this on the real runtime (`node scripts/dev.mjs --stripe`), and its `scripts/e2e.mjs` runs 28 scenarios — every payments feature, including destination charges, transfers, payouts, and platform billing with `catalog sync` — against a local Stripe simulator without keys.
