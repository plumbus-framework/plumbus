# Testing payments

**Previous:** [webhooks.md](./webhooks.md) · **Next:** [security.md](./security.md)

| Level | Tool | Network |
|---|---|---|
| App logic (handlers, your capabilities) | `@plumbus/payments/testing`: `createFakePaymentProvider`, `createPaymentsTestContext`, `deliverTestWebhook` | none |
| Stripe request/response shapes | `@plumbus/payments-stripe/testing`: `createStripeHttpStub`, `signStripeWebhook`, `stripeSnapshotEvent`, `stripeThinAccountEvent` | none |
| Quick smoke, one process, no database | `examples/payments-stripe-smoke` → `node check.mjs` | none (offline battery) |
| **Real Plumbus runtime** (Postgres, migrations, API + worker, outbox) against a local Stripe simulator | `examples/payments-connect-app` → `node scripts/e2e.mjs` (28 scenarios: direct and destination charges, split payments, holds, saved cards, invoices, links, subscriptions, payouts, disputes, plans, seats, usage, entitlements) | none (needs Docker or `E2E_DB_*`) |
| Real Stripe (test mode) | `examples/payments-connect-app` → `node scripts/dev.mjs --stripe` + `stripe listen`, or `STRIPE_SECRET_KEY=sk_test_… node check.mjs` in the smoke app | Stripe test mode |

`examples/payments-connect-app/stripe-sim/` is a stateful Stripe simulator (objects on sellers' accounts and the platform, Connect and Billing rules, idempotency, signed snapshot + thin webhooks from `@self` and `@accounts`, `/_sim` control API). New payments features add their Stripe endpoints there and a scenario in `scenarios/index.mjs`; its README lists the steps.

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

Config rules and every option path documented; fee math (items, custom amounts, captures, links, subscription percentages); charge types and routing (direct, destination with and without `on_behalf_of`, platform charges, which account each object lives on, events from the wrong account ignored); payment pages (items, options, embedded pages, discounts and tax); invoices; holds; saved cards and off-session charges (declines, authentication, the recovery page); subscriptions (checkout, renewals, failed payments, cancel and resume, expired checkouts); links; payouts (schedules, instant payouts, payout events); disputes (evidence, accept); transfers (with and without a source charge, reversals, retries); platform billing (catalog sync and check against a stateful Stripe catalog, subscribe, seats, meters, entitlements, plan changes, the AI usage bridge); onboarding (dashboard choice, permanence, countries, embedded mode, races); charges (fees, idempotent `requestId` and its reuse for another request, clients and siblings sharing an email, concurrent first charges for one client, finishing a charge a crash left unsent, currencies, reserved metadata, ownership); refunds (partial, over-refund, access, retries after a lost response, pending refunds counted once, failed refunds giving the amount back, racing refunds); webhook ingest (signatures, mode, unknown seller, unhandled types, duplicates, redelivery after a failure, concurrent workers, stale snapshots, reads during a provider call, no backwards moves, foreign sessions reusing a charge id, refunds outside the app, disputes, merchant status and requirement order, provider outages, service-only access); exact fee math for any decimal percent; the Fastify route (exact raw bytes, JSON elsewhere untouched, body limit, 500 on storage failure); Stripe request shapes for every call; Checkout expiry margins and emoji-safe product names; fields Stripe leaves unexpanded; Stripe error translation; destination setup and `doctor`; an end-to-end run through both packages with Stripe-signed events.
