# `@plumbus/payments-stripe` smoke app

A self-contained smoke test for **`@plumbus/payments`** + **`@plumbus/payments-stripe`**:
sellers connect a Stripe account (Accounts v2), charge a client through Checkout
on their own account with a platform fee, and get the payment recorded from
Stripe-signed webhooks.

It is **not** part of the pnpm workspace and installs nothing: it imports the
built `dist/` of `@plumbus/core`, `@plumbus/payments`, and
`@plumbus/payments-stripe`, and resolves `fastify` from the payments package's
own `node_modules`. It never affects `build`, `test`, `lint`, `typecheck`, or
`publish`.

For the full stack (Postgres, migrations, API + worker, outbox, a stateful Stripe
simulator, 28 scenarios covering every payments feature) use [`../payments-connect-app`](../payments-connect-app/).

The app shell (`lib/app.mjs`) keeps data in memory and runs the worker step
inline, so no database or worker process is needed. It builds its own context
from `@plumbus/core` exports because `@plumbus/core/testing` (and therefore
`@plumbus/payments/testing`) only load inside Vitest.

## Build first

```bash
# from the repo root
pnpm turbo run build --filter=@plumbus/payments-stripe
```

## Automated check

```bash
cd examples/payments-stripe-smoke
node check.mjs
```

| Battery | Needs | Checks |
|---|---|---|
| Offline (always) | nothing | Stripe Express/liability rule at startup; onboarding link; signed **thin** account event over HTTP activates the seller; `createCharge` sends the 5% fee with `Stripe-Account`; signed **snapshot** `checkout.session.completed` marks the charge paid once (redelivered twice); forged signature → 400 |
| Live (opt-in) | `STRIPE_SECRET_KEY=sk_test_…` | `doctor --live` findings; creates a real v2 seller account + onboarding link in test mode |
| Live Checkout (opt-in) | also `STRIPE_SMOKE_SELLER=acct_…` (an onboarded test seller) | creates a Checkout session with a platform fee; pay it with `4242 4242 4242 4242` |

Live keys are refused. Exit code is non-zero on any failure.

## Interactive walk-through (Stripe test mode)

Terminal 1 — forward events (the printed `whsec_…` goes in `STRIPE_WEBHOOK_SECRETS`):

```bash
stripe listen --latest \
  --forward-to localhost:3000/payments/webhooks/stripe \
  --forward-connect-to localhost:3000/payments/webhooks/stripe \
  --thin-events 'v2.core.account.created,v2.core.account.updated,v2.core.account.closed,v2.core.account[requirements].updated,v2.core.account[configuration.merchant].updated,v2.core.account[configuration.merchant].capability_status_updated' \
  --forward-thin-to localhost:3000/payments/webhooks/stripe
```

Terminal 2:

```bash
STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRETS=whsec_… node serve.mjs
```

Then:

1. `curl -X POST localhost:3000/seller/onboard` → open `onboardingUrl`, complete onboarding with Stripe's test data.
2. Open `http://localhost:3000/seller/return` (or wait for the account webhook) → `status: "active"`.
3. `curl -X POST localhost:3000/charges -H 'content-type: application/json' -d '{"amount":2500,"currency":"usd","description":"Test lesson"}'` → open `charge.url`, pay with `4242 4242 4242 4242`.
4. `curl localhost:3000/charges` → the charge becomes `paid`; the server logs `payments.charge.paid`.
5. `curl -X POST localhost:3000/charges/<id>/refund -H 'content-type: application/json' -d '{}'` → refund; the webhook logs `payments.charge.refunded`.

Everything lives in memory and is gone when the server stops. Test-mode accounts stay in your Stripe sandbox; delete them from the Dashboard if you like.
