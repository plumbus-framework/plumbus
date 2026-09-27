# @plumbus/payments-stripe

Stripe Connect provider for [`@plumbus/payments`](../payments/), built on Stripe's newest APIs:

- sellers are **Accounts v2** connected accounts (full, Express, or no Stripe dashboard — your choice per app, the seller's choice per account);
- clients pay through **Checkout** on the seller's own account (direct charges) with your application fee;
- account changes arrive as **thin** v2 events and payment events as **snapshot** events, both verified from the raw body.

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
plumbus payments doctor --live --webhook-url https://api.example.com/payments/webhooks/stripe
```

Stripe's Connect rules are checked when the app starts: Express sellers require your platform to pay fees and cover losses; platform-covered losses always require platform-paid fees.

## Documentation

- **Human docs:** [`docs/payments/stripe.md`](../../docs/payments/stripe.md), [`docs/payments/webhooks.md`](../../docs/payments/webhooks.md)
- **Agent recipes:**
  - [`instructions/README.md`](./instructions/README.md) — index
  - [`instructions/framework.md`](./instructions/framework.md) — APIs used, exports, critical rules
  - [`instructions/configure-stripe.md`](./instructions/configure-stripe.md) — keys, dashboards, liability
  - [`instructions/webhooks.md`](./instructions/webhooks.md) — destinations, secrets, local forwarding
  - [`instructions/testing.md`](./instructions/testing.md) — signed events, HTTP stub, test mode
- **Test app:** [`examples/payments-connect-app`](../../examples/payments-connect-app/) — real Plumbus runtime + local Stripe simulator, 13 end-to-end scenarios
- **Smoke app:** [`examples/payments-stripe-smoke`](../../examples/payments-stripe-smoke/) — one process, no database

## The Plumbus ecosystem

`@plumbus/payments-stripe` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Payments docs** — [docs/payments/](../../docs/payments/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
