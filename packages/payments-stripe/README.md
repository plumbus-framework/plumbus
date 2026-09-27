# @plumbus/payments-stripe

Stripe provider for [`@plumbus/payments`](../payments/), built on Stripe's newest APIs:

- sellers are **Accounts v2** connected accounts (full, Express, or no Stripe dashboard — your choice per app, the seller's choice per account), with the merchant and/or recipient configuration their charge type needs;
- clients pay through **Checkout** (hosted or embedded) on the seller's own account (direct charges) or on your platform paid on to the seller (destination charges), with your application fee — or by invoice, saved card, payment link, or subscription;
- your platform splits payments with **transfers**, sets payout schedules through **Balance Settings**, and bills its own plans with **Stripe Billing** (prices by lookup key, entitlements, meters);
- account changes arrive as **thin** v2 events and everything else as **snapshot** events from the platform and sellers' accounts, all verified from the raw body.

Pinned to Stripe API version **`2026-08-26.dahlia`** through the official `stripe` SDK (a dependency — do not add `stripe` to your app).

Peers: `@plumbus/core` **`0.7.x`**, `@plumbus/payments` **`0.2.x`**.

## Install

```bash
pnpm add @plumbus/payments @plumbus/payments-stripe
```

## Usage

```ts
import { stripeProvider } from '@plumbus/payments-stripe';

const provider = stripeProvider({
  secretKey: () => process.env.STRIPE_SECRET_KEY ?? '',       // sk_… or rk_…
  webhookSecrets: () => (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean),
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,         // embedded components only
});
// createPayments({ provider, ... }) — see @plumbus/payments
```

```bash
plumbus payments webhooks setup --url https://api.example.com/payments/webhooks/stripe
plumbus payments catalog sync     # with billing: products, prices, features, meters
plumbus payments doctor --live --webhook-url https://api.example.com/payments/webhooks/stripe
```

Stripe's Connect rules are checked when the app starts: Express sellers require your platform to pay fees and cover losses; platform-covered losses always require platform-paid fees. Stripe's recommendations (destination charges for Express and no-dashboard sellers) are reported as warnings.

## Documentation

- **Human docs:** [`docs/payments/stripe.md`](../../docs/payments/stripe.md), [`docs/payments/webhooks.md`](../../docs/payments/webhooks.md)
- **Agent recipes:**
  - [`instructions/README.md`](./instructions/README.md) — index
  - [`instructions/framework.md`](./instructions/framework.md) — APIs used, exports, critical rules
  - [`instructions/configure-stripe.md`](./instructions/configure-stripe.md) — keys, dashboards, charge types, liability, payouts, the billing catalog
  - [`instructions/webhooks.md`](./instructions/webhooks.md) — destinations, secrets, local forwarding
  - [`instructions/testing.md`](./instructions/testing.md) — signed events, HTTP stub, test mode
- **Test app:** [`examples/payments-connect-app`](../../examples/payments-connect-app/) — real Plumbus runtime + local Stripe simulator, 28 end-to-end scenarios
- **Smoke app:** [`examples/payments-stripe-smoke`](../../examples/payments-stripe-smoke/) — one process, no database

## The Plumbus ecosystem

`@plumbus/payments-stripe` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Payments docs** — [docs/payments/](../../docs/payments/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
