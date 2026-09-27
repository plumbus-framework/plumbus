# @plumbus/payments

Payments for Plumbus apps, in two independent halves:

- **Sellers:** your users charge their own clients — tutors and students, clinics and patients, shops and customers — with your app as the platform in between and an optional cut for you. Payment pages (hosted or embedded), invoices, holds, saved cards and off-session charges, payment links, subscriptions, a client portal, disputes, payouts, direct or destination charges, and marketplace splits with transfers.
- **Billing:** your app bills its own customers for plans — per-seat prices, usage meters (with a bridge from Plumbus's AI cost records), entitlements that gate features, a billing portal — from a catalog declared in config.

Provider-neutral; install a provider package with it (today [`@plumbus/payments-stripe`](../payments-stripe/)).

Everything is a Plumbus primitive: money moves through **capabilities** (access policies, audit, idempotency), provider state is mirrored into tenant-scoped **entities**, and your app reacts to **events** such as `payments.charge.paid`. Webhooks are verified on a raw-body route and applied by the worker, so duplicates and out-of-order deliveries are harmless.

Peers: `@plumbus/core` **`0.7.x`** (runtime **≥ 0.7.7**), optional `fastify` `^5` for the webhook route.

## Install

```bash
pnpm add @plumbus/payments @plumbus/payments-stripe
```

## Usage

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

## Documentation

- **Human docs:** [`docs/payments/`](../../docs/payments/) — start with [use-cases.md](../../docs/payments/use-cases.md) to pick features and [options.md](../../docs/payments/options.md) for every choice; [billing.md](../../docs/payments/billing.md) for your own plans
- **Agent recipes:**
  - [`instructions/README.md`](./instructions/README.md) — index
  - [`instructions/framework.md`](./instructions/framework.md) — boundary, exports, critical rules
  - [`instructions/wiring.md`](./instructions/wiring.md) — adding payments to an app
  - [`instructions/options.md`](./instructions/options.md) — choosing options
  - [`instructions/capabilities-and-events.md`](./instructions/capabilities-and-events.md) — calling capabilities, reacting to events
  - [`instructions/testing.md`](./instructions/testing.md) — fake provider and webhook helper

## The Plumbus ecosystem

`@plumbus/payments` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Payments docs** — [docs/payments/](../../docs/payments/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
