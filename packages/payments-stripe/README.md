# @plumbus/payments-stripe

> **Stripe for [Plumbus](https://github.com/plumbus-framework/plumbus) payments.** The Stripe provider for [`@plumbus/payments`](../payments/): Connect for sellers, Checkout, invoices, subscriptions, and Stripe Billing for your own plans, on Stripe's newest APIs.

[![npm](https://img.shields.io/npm/v/@plumbus/payments-stripe.svg)](https://www.npmjs.com/package/@plumbus/payments-stripe)
[![license](https://img.shields.io/npm/l/@plumbus/payments-stripe.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/payments 0.2.x](https://img.shields.io/badge/peer-%40plumbus%2Fpayments%200.2.x-blue)](https://www.npmjs.com/package/@plumbus/payments)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/payments`](../payments/) is its provider-neutral payments add-on: money moves through capabilities, provider state is mirrored into entities, and apps react to `payments.*` events.

`@plumbus/payments-stripe` is the **Stripe provider** for [`@plumbus/payments`](../payments/), built on Stripe's newest APIs:

- sellers are **Accounts v2** connected accounts (full, Express, or no Stripe dashboard — your choice per app, the seller's choice per account), with the merchant and/or recipient configuration their charge type needs;
- clients pay through **Checkout** (hosted or embedded) on the seller's own account (direct charges) or on your platform paid on to the seller (destination charges), with your application fee — or by invoice, saved card, payment link, or subscription;
- your platform splits payments with **transfers**, sets payout schedules through **Balance Settings**, and bills its own plans with **Stripe Billing** (prices by lookup key, entitlements, meters);
- account changes arrive as **thin** v2 events and everything else as **snapshot** events from the platform and sellers' accounts, all verified from the raw body.

Pinned to Stripe API version **`2026-08-26.dahlia`** through the official `stripe` SDK (a dependency — do not add `stripe` to your app).

## Why?

`@plumbus/payments` defines what an app can do with money; a provider package does the vendor calls. Keeping Stripe in its own package means the payments contract stays provider-neutral, apps without Stripe never load its SDK, and Stripe's rules (Connect liability, API version, webhook formats) are checked in one place:

- Connect rules are enforced when the app starts, and Stripe's recommendations are reported as warnings.
- `plumbus payments webhooks setup` creates the event destinations this package needs, and `plumbus payments doctor --live` checks keys, Accounts v2 access, destinations, events, the API version, and the billing catalog.
- `plumbus payments catalog sync` turns the `billing` config into Stripe products, prices, features, and meters.

## What you get

| Surface | What it does |
|---|---|
| `stripeProvider(options)` | The `@plumbus/payments` provider for `createPayments({ provider })`. `(await provider.client())` returns the configured `Stripe` instance for Stripe-only reads. |
| Sellers | Accounts v2 connected accounts, v2 Account Links onboarding, Account Sessions for embedded components, Express login links. |
| Payments | Checkout (hosted and embedded, custom amounts, holds, saving the card), invoices, off-session charges on saved cards, payment links, subscriptions, refunds, dispute evidence. |
| Money movement | Direct, destination, and platform charges; transfers and reversals; payout schedules through Balance Settings and instant payouts. |
| Stripe Billing | Catalog sync and check (products, prices by lookup key, entitlement features, meters), billing customers, active entitlements, meter events. |
| Webhooks | Snapshot and thin event verification against several signing secrets; `STRIPE_SNAPSHOT_EVENTS`, `STRIPE_THIN_EVENTS`, `STRIPE_DESTINATION_NAMES`. |
| `@plumbus/payments-stripe/testing` | `signStripeWebhook`, `stripeSnapshotEvent`, `stripeThinAccountEvent`, `createStripeHttpStub`. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Stripe Connect sellers and Stripe Billing plans in a Plumbus app | **`@plumbus/payments-stripe`** (this package) with [`@plumbus/payments`](../payments/) |
| Another payment provider | A package implementing the `PaymentProvider` contract from `@plumbus/payments` |
| App tests without Stripe | The fake provider in `@plumbus/payments/testing` |
| Stripe request shapes and signed events in tests | `@plumbus/payments-stripe/testing` |
| Stripe-only reads the neutral API does not cover | `(await provider.client())`, never for creating charges, refunds, transfers, subscriptions, or accounts |

## Status

Stripe provider for `@plumbus/payments`, version `0.2.2` (version-locked **`0.2.x`**); peers `@plumbus/core` **`0.7.x`** and `@plumbus/payments` **`0.2.x`**; `stripe` 22.x is a dependency. A platform without sellers (billing only) needs no Stripe Connect with `@plumbus/payments` 0.2.1+. Tested offline with Stripe-signed events and an HTTP stub, and end to end on the real Plumbus runtime against a local Stripe simulator by [`examples/payments-connect-app`](../../examples/payments-connect-app/) (28 scenarios).

Not supported, by design: OAuth "connect an existing Stripe account" (v1-only), legacy Standard/Express/Custom account types, and private-preview features.

## Install

```bash
pnpm add @plumbus/payments @plumbus/payments-stripe
```

Peers: `@plumbus/core` **`0.7.x`**, `@plumbus/payments` **`0.2.x`**. Copy them literally; see `node_modules/@plumbus/core/instructions/peer-dependencies.md`.

If agent wiring predates the payments instructions, refresh:

```bash
plumbus init --patch --agent all
plumbus doctor
```

## Quick start

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

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `secretKey` | required | `sk_…` or restricted `rk_…` key, or a function returning it; the key prefix sets live or test mode |
| `webhookSecrets` | required | Signing secrets of every event destination (and old ones during a rotation), or a function returning them |
| `publishableKey` | none | Embedded payment pages and Connect embedded components |
| `webhookToleranceSeconds` | `300` | Seconds a signature timestamp may be old |
| `maxNetworkRetries` | `2` | SDK retries on network errors and 409/429/5xx |
| `timeoutMs` | `80000` | Request timeout (Stripe's default) |
| `api` | Stripe | Advanced: another host, such as stripe-mock |
| `httpClient` | Stripe SDK | Advanced/testing: a custom HTTP client (see `/testing`) |

Keys, dashboards, charge types, liability, restricted-key permissions, payouts, and the billing catalog: [`instructions/configure-stripe.md`](./instructions/configure-stripe.md).

## Key gotchas

- **Liability rules fail at startup.** Stripe's Connect rules are checked when the app starts: Express sellers require your platform to pay fees and cover losses; platform-covered losses always require platform-paid fees. Stripe's recommendations (destination charges for Express and no-dashboard sellers) are reported as warnings.
- **Do not add `stripe` to your app.** The SDK is this package's dependency; app code calls the payments capabilities and helpers.
- **Keys are read on first use.** Pass `secretKey` and `webhookSecrets` as functions reading env or a secret manager. Events from the other mode (live or test) are ignored.
- **Both processes need the secret key.** The API and the worker need `STRIPE_SECRET_KEY` (the worker re-reads Stripe for every webhook); the API also needs `STRIPE_WEBHOOK_SECRETS`.
- **Each destination signs with its own secret.** Pass every secret in `webhookSecrets`, plus the old ones during a rotation.
- **Only objects created through this package are tracked.** Payments a seller makes in their own dashboard are ignored (their refunds and disputes too, unless the charge is ours), and so are platform objects without this package's metadata.
- **Run `plumbus payments catalog sync` after changing `billing`.** Subscriptions find their prices by lookup key; a missing one fails with `stripe_price_missing`.
- **Express moves Stripe's fees to you.** Your platform pays Stripe's processing and Connect fees and covers losses; set `platformFee` to include Stripe's fee.
- **A test key in production is an error.** `doctor` reports a `sk_test_`/`rk_test_` key with `NODE_ENV=production`.

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

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/payments`](../payments/)
- **Payments docs** — [docs/payments/](../../docs/payments/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
