# @plumbus/payments

Payments for Plumbus apps where **your users charge their own clients** — tutors and students, clinics and patients, shops and customers — with your app as the platform in between and an optional cut for you. Provider-neutral; install a provider package with it (today [`@plumbus/payments-stripe`](../payments-stripe/)).

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

Then re-export `payments.capabilities` from `app/capabilities`, the entities and events from `app/entities` / `app/events`, call `registerPaymentRoutes(app, routeConfig, payments)` in `app/server.ts`, run migrations and the worker, and create webhook destinations with `plumbus payments webhooks setup`. Full steps: [`instructions/wiring.md`](./instructions/wiring.md).

| Capability | Does |
|---|---|
| `payments.startMerchantOnboarding` | Create the caller's seller account and return an onboarding link |
| `payments.createMerchantSession` | Session for the provider's embedded seller components |
| `payments.getMerchantAccount` / `syncMerchantAccount` | Read / refresh the seller's status |
| `payments.openMerchantDashboard` | Link to the seller's provider dashboard |
| `payments.createCharge` | Payment link for a client, with your platform fee |
| `payments.listCharges` / `getCharge` | Read charges |
| `payments.refundCharge` | Refund all or part of a paid charge |

## Documentation

- **Human docs:** [`docs/payments/`](../../docs/payments/) — start with [options.md](../../docs/payments/options.md) for every choice
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
