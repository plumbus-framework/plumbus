# @plumbus/payments

> **Payments for [Plumbus](https://github.com/plumbus-framework/plumbus) apps.** Your users charge their own clients with your app as the platform, and your app bills its own customers for plans, as Plumbus capabilities, entities, and events with verified webhooks.

[![npm](https://img.shields.io/npm/v/@plumbus/payments.svg)](https://www.npmjs.com/package/@plumbus/payments)
[![license](https://img.shields.io/npm/l/@plumbus/payments.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare capabilities, entities, events, and flows through `define*()` functions; the framework generates routes, validation, audit, security, and types.

`@plumbus/payments` is the **payments add-on**. Payments for Plumbus apps, in two independent halves:

- **Sellers:** your users charge their own clients — tutors and students, clinics and patients, shops and customers — with your app as the platform in between and an optional cut for you. Payment pages (hosted or embedded), invoices, holds, saved cards and off-session charges, payment links, subscriptions, a client portal, disputes, payouts, direct or destination charges, and marketplace splits with transfers.
- **Billing:** your app bills its own customers for plans — per-seat prices, usage meters (with a bridge from Plumbus's AI cost records), entitlements that gate features, a billing portal — from a catalog declared in config.

Provider-neutral; install a provider package with it (today [`@plumbus/payments-stripe`](../payments-stripe/)).

## Why?

Moving money through a provider takes more than its SDK: a webhook route that verifies raw bodies, a ledger that survives duplicate and out-of-order deliveries, local copies of provider state, fee math, and access checks on every money movement. This package ships those pieces, so an app does not write them itself.

Everything is a Plumbus primitive: money moves through **capabilities** (access policies, audit, idempotency), provider state is mirrored into tenant-scoped **entities**, and your app reacts to **events** such as `payments.charge.paid`. Webhooks are verified on a raw-body route and applied by the worker, so duplicates and out-of-order deliveries are harmless.

## What you get

| Surface | What it does |
|---|---|
| `createPayments(config)` | Validates options; returns `capabilities` (only those the config turns on), `entities`, `events`, `platform` and `billing` helpers, `effects`, `catalog`, `diagnose`, `setupWebhooks`, `syncCatalog`, `checkCatalog`. |
| Capabilities | Sellers: onboarding, charges, clients and the client portal, links, subscriptions, disputes, payouts, transfers. Billing: plans, subscribe, change, cancel, portal, entitlements. Domain `payments`. |
| `paymentEntities` | 14 entities: provider state mirrored into tenant-scoped rows (`PaymentMerchantAccount`, `PaymentCharge`, `PaymentSubscription`, …) and the webhook event ledger. |
| `paymentEvents` | 25 `payments.*` events (`payments.charge.paid`, `payments.entitlements.updated`, …), including the internal `payments.provider.eventReceived`. |
| `registerPaymentRoutes(app, routeConfig, payments)` | The webhook route: raw body, signature check, live/test mode guard, ledger, dedupe. |
| `payments.platform` / `payments.billing` | Server-side helpers: platform charges and `transferToSeller`; `hasFeature`, `setSeats`, `recordUsage`, `purchase`, `aiUsageBridge`. |
| CLI (ships in `@plumbus/core`) | `plumbus payments doctor`, `plumbus payments webhooks setup`, `plumbus payments catalog sync` / `check`. |
| `@plumbus/payments/testing` | `createFakePaymentProvider`, `createPaymentsTestContext`, `deliverTestWebhook`, `withAuth`. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Your users charge their own clients, with your app as the platform | **`@plumbus/payments`** with `seller`, plus a provider package |
| Your app bills its own customers for plans, seats, or usage | **`@plumbus/payments`** with `billing` |
| One-off purchases without subscription plans | `billing: { customer }` and `payments.billing.purchase` (0.2.1+) |
| Stripe as the provider | [`@plumbus/payments-stripe`](../payments-stripe/) |
| Tests with no provider at all | The fake provider in `@plumbus/payments/testing` |

## Status

Optional add-on of `@plumbus/core`, version `0.2.2` (version-locked **`0.2.x`**); peer `@plumbus/core` **`0.7.x`**, optional peer `fastify` `^5` for the webhook route. **Runtime floor:** `@plumbus/core` **≥ 0.7.7** (`field.bigint()` for amounts, and discovery of exported collections such as `payments.capabilities`); agent wiring **v18** (core 0.7.7+) links these instructions. Verified end to end on the real Plumbus runtime by [`examples/payments-connect-app`](../../examples/payments-connect-app/) (28 scenarios, against a local Stripe simulator). Install alone does nothing until the collections, webhook route, and worker are wired.

Not included: linking an existing Stripe account (OAuth), a custom card form in your page (use embedded payment pages), seller-defined products and price lists at the provider, and Stripe private previews. See [what this release does not offer](../../docs/payments/options.md#choices-this-release-does-not-offer).

## Install

```bash
pnpm add @plumbus/payments @plumbus/payments-stripe
```

Peers: `@plumbus/core` **`0.7.x`** (runtime **≥ 0.7.7**), optional `fastify` `^5` for the webhook route. Copy them literally; see `node_modules/@plumbus/core/instructions/peer-dependencies.md`.

If agent wiring predates the payments instructions, refresh:

```bash
plumbus init --patch --agent all
plumbus doctor
```

## Quick start

```ts
// app/payments/index.ts
import { createPayments } from '@plumbus/payments';
import { stripeProvider } from '@plumbus/payments-stripe';

export const payments = createPayments({
  provider: stripeProvider({
    secretKey: () => process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecrets: () => (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean),
  }),
  seller: { owner: 'user' },                   // or 'tenant'
  access: { sellers: { roles: ['seller'] } },
  dashboards: { full: true },                  // and/or express, none
  countries: { default: 'US' },
  platformFee: { percent: 5 },
  urls: {
    onboardingReturn: 'https://app.example.com/payments/connected',
    onboardingRefresh: 'https://app.example.com/payments/connect',
    checkoutSuccess: 'https://app.example.com/pay/{chargeId}/thanks',
    checkoutCancel: 'https://app.example.com/pay/{chargeId}',
  },
});
```

Then export `payments.capabilities` from `app/capabilities` (`export const paymentCapabilities = payments.capabilities`), `paymentEntities` and `paymentEvents` from `app/entities` / `app/events`, call `registerPaymentRoutes(app, routeConfig, payments)` in `app/server.ts`, run migrations and the worker, create webhook destinations with `plumbus payments webhooks setup`, and, with `billing`, create your plans with `plumbus payments catalog sync`. Full steps: [`instructions/wiring.md`](./instructions/wiring.md).

## How requests flow

1. A seller calls `startMerchantOnboarding`; a provider account is created for them and they finish onboarding on the provider's page or in embedded components.
2. The provider reports progress by webhook; the worker updates `PaymentMerchantAccount` and emits `payments.merchant.updated`.
3. The seller calls `createCharge`; the client gets a payment page (hosted link or embedded), an invoice, or is charged on a saved card.
4. The client pays; the webhook route verifies, records, and queues the event; the worker re-reads the provider and marks the charge paid; your app reacts to `payments.charge.paid`.
5. Refunds, disputes, subscriptions, invoices, transfers, payouts, and entitlements follow the same webhook path.

## Public API

| Capabilities | Do |
|---|---|
| `startMerchantOnboarding`, `createMerchantSession`, `getMerchantAccount`, `syncMerchantAccount`, `openMerchantDashboard` | Connect the caller's seller account, embedded components, status, dashboard |
| `createCharge`, `listCharges`, `getCharge`, `refundCharge`, `captureCharge`, `cancelCharge` | Payment pages and invoices with your platform fee, holds, refunds |
| `listClients`, `saveClientPaymentMethod`, `listClientPaymentMethods`, `chargeSavedMethod`, `createClientPortalSession`, … | Saved cards, charging them later, the client portal |
| `createPaymentLink`, `createSubscription`, `cancelSubscription`, … | Reusable links, subscriptions sold to clients |
| `listDisputes`, `respondToDispute`, `acceptDispute` | Answering disputes |
| `listPayouts`, `getPayoutSettings`, `updatePayoutSchedule`, `createInstantPayout`, `listTransfers` | Seller payouts and transfers |
| `listPlans`, `subscribeToPlan`, `getPlanSubscription`, `changePlan`, `cancelPlanSubscription`, `openBillingPortal`, `getEntitlements` | Your own plans |

Server-side helpers for your own capabilities: `payments.platform` (platform charges, `transferToSeller`) and `payments.billing` (`hasFeature`, `setSeats`, `recordUsage`, `purchase`, `aiUsageBridge`). All capabilities: [`instructions/capabilities-and-events.md`](./instructions/capabilities-and-events.md).

## Key gotchas

- **Money moves only through the payments capabilities and helpers.** Never call the provider SDK from app capabilities to create charges or refunds; the capabilities enforce access, ownership, audit, idempotency, and fees.
- **Deliver on `payments.charge.paid`, never on the success redirect.** `urls.checkoutSuccess` is a thank-you page.
- **Never accept amounts or fees from the browser as trusted.** The server computes the platform fee from `platformFee`; for a fixed price, call `createCharge` from your own capability with the server-side amount.
- **Amounts are integers in minor units.** 5000 is $50.00 for `usd` and ¥5000 for `jpy`; currencies are lowercase ISO codes.
- **Owners come from auth.** The seller is `ctx.auth.userId` or `ctx.auth.tenantId`; there is no input to act for someone else.
- **Register everything and run the worker.** A missing entity or event fails at runtime, and without `processProviderEvent` and a running worker, webhooks never apply. There is no `ctx.payments`.
- **Do not list `payments-webhook` in your own access policies.** It is the service account the webhook route and worker run as.
- **Dashboard and responsibilities are permanent per seller.** A seller who wants another dashboard needs a new account.
- **Gate paid features on the server** with `payments.billing.hasFeature`, and run `plumbus payments catalog sync` after changing `billing`.
- **Keep `webhooks.storePayload` off** unless you need raw bodies; they contain client personal data.

## Documentation

- **Human docs:** [`docs/payments/`](../../docs/payments/) — start with [use-cases.md](../../docs/payments/use-cases.md) to pick features and [options.md](../../docs/payments/options.md) for every choice; [billing.md](../../docs/payments/billing.md) for your own plans
- **Agent recipes:**
  - [`instructions/README.md`](./instructions/README.md) — index
  - [`instructions/framework.md`](./instructions/framework.md) — boundary, exports, critical rules
  - [`instructions/wiring.md`](./instructions/wiring.md) — adding payments to an app
  - [`instructions/options.md`](./instructions/options.md) — choosing options
  - [`instructions/capabilities-and-events.md`](./instructions/capabilities-and-events.md) — calling capabilities, reacting to events
  - [`instructions/testing.md`](./instructions/testing.md) — fake provider and webhook helper
- **Test app:** [`examples/payments-connect-app`](../../examples/payments-connect-app/) — real Plumbus runtime + local Stripe simulator, 28 end-to-end scenarios

## The Plumbus ecosystem

`@plumbus/payments` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Stripe provider** — [`@plumbus/payments-stripe`](../payments-stripe/)
- **Payments docs** — [docs/payments/](../../docs/payments/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
