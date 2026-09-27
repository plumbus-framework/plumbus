# Testing payments

**Previous:** [webhooks.md](./webhooks.md) · **Next:** [security.md](./security.md)

| Level | Tool | Network |
|---|---|---|
| App logic (handlers, your capabilities) | `@plumbus/payments/testing`: `createFakePaymentProvider`, `createPaymentsTestContext`, `deliverTestWebhook` | none |
| Stripe request/response shapes | `@plumbus/payments-stripe/testing`: `createStripeHttpStub`, `signStripeWebhook`, `stripeSnapshotEvent`, `stripeThinAccountEvent` | none |
| Quick smoke, one process, no database | `examples/payments-stripe-smoke` → `node check.mjs` | none (offline battery) |
| **Real Plumbus runtime** (Postgres, migrations, API + worker, outbox) against a local Stripe simulator | `examples/payments-connect-app` → `node scripts/e2e.mjs` (13 scenarios; later phases listed as planned) | none (needs Docker or `E2E_DB_*`) |
| Real Stripe (test mode) | `examples/payments-connect-app` → `node scripts/dev.mjs --stripe` + `stripe listen`, or `STRIPE_SECRET_KEY=sk_test_… node check.mjs` in the smoke app | Stripe test mode |

`examples/payments-connect-app/stripe-sim/` is a stateful Stripe simulator (Connect rules, idempotency, signed snapshot + thin webhooks, `/_sim` control API). New payments features add their Stripe endpoints there and a scenario in `scenarios/index.mjs`; its README lists the steps.

`@plumbus/payments/testing` builds on `@plumbus/core/testing`, so use it inside Vitest (`plumbus test`). `@plumbus/payments-stripe/testing` only needs the Stripe SDK.

## Fake provider example

```ts
const fake = createFakePaymentProvider();
const payments = createPayments({ ...config, provider: fake });
const ctx = createPaymentsTestContext(payments, {
  auth: { userId: 'seller-1', tenantId: 't1', roles: ['seller'] },
});

await executeCapability(payments.capabilities.startMerchantOnboarding, ctx, {});
const accountId = [...fake.accounts.keys()][0]!;
fake.completeOnboarding(accountId);
await deliverTestWebhook(payments, ctx, fake.event('account', accountId));
```

`deliverTestWebhook` runs the same verify → ingest → worker path as production and returns `{ status: 'received' | 'ignored' | 'duplicate' | 'rejected', ignoredReason, ledgerId, processed }`.

## Stripe stub example

```ts
const stub = createStripeHttpStub().on('POST /v1/checkout/sessions', () => ({ id: 'cs_1', object: 'checkout.session', status: 'open', livemode: false }));
const provider = stripeProvider({ secretKey: 'sk_test_x', webhookSecrets: ['whsec_x'], httpClient: stub.httpClient, maxNetworkRetries: 0 });
// stub.requests[n].headers['stripe-account'], ['idempotency-key'], ['stripe-version'], .body (form fields or JSON)
```

## What the packages' own tests cover

Config rules and every option path documented; fee math; onboarding (dashboard choice, permanence, countries, embedded mode, races); charges (fees, idempotent `requestId`, clients, currencies, reserved metadata, ownership); refunds (partial, over-refund, access); webhook ingest (signatures, mode, unknown seller, unhandled types, duplicates, stale snapshots, no backwards moves, refunds outside the app, disputes, merchant status, provider outages, service-only access); the Fastify route (exact raw bytes, JSON elsewhere untouched, body limit, 500 on storage failure); Stripe request shapes for every call; Stripe error translation; destination setup and `doctor`; an end-to-end run through both packages with Stripe-signed events.
