# Payments

`@plumbus/payments` moves money for your app in two ways, separately or together:

- **Sellers** — the people who use your app **charge their own clients** (tutors charging students, clinics charging patients, shops charging customers), with your app as the platform in between: payment pages, invoices, saved cards, holds, payment links, subscriptions, payouts, disputes, and marketplace splits, with an optional cut for you.
- **Billing** — your app **bills its own customers** for plans: per-seat and usage-based prices (e.g. AI tokens), entitlements that switch features on, and a billing portal.

`@plumbus/payments-stripe` connects it to **Stripe** (Connect for sellers, Billing for your plans) on Stripe's newest APIs.

| Doc | Read when |
|---|---|
| [getting-started.md](./getting-started.md) | Adding payments to an app, step by step |
| [options.md](./options.md) | Choosing every option — who covers losses, dashboards, charge type, fees, payment pages, payouts, plans — and what is not offered |
| [use-cases.md](./use-cases.md) | Which features to combine for your kind of app, with complete configs |
| [billing.md](./billing.md) | Your app's own plans: catalog, seats, usage meters, entitlements, the AI usage bridge |
| [stripe.md](./stripe.md) | Stripe specifics: Accounts v2, API version, keys, what each call does |
| [webhooks.md](./webhooks.md) | How webhooks are received, verified, routed to a tenant, deduplicated, and applied |
| [testing.md](./testing.md) | Fake provider, signed Stripe events, HTTP stub, smoke app, end-to-end app |
| [security.md](./security.md) | Threat model and the rules the packages enforce |

## How it fits Plumbus

| Concern | Where |
|---|---|
| Money movement | Capabilities (`payments.createCharge`, `payments.refundCharge`, `payments.subscribeToPlan`, …) — access policies, audit, idempotency — and server-side helpers for your own capabilities (`payments.platform.*`, `payments.billing.*`) |
| State | Entities (`PaymentMerchantAccount`, `PaymentCharge`, `PaymentSubscription`, …) mirroring the provider, tenant-scoped |
| Reactions | Events (`payments.charge.paid`, `payments.entitlements.updated`, …) handled by your `eventHandler` capabilities |
| Webhooks | `registerPaymentRoutes()` in `app/server.ts` + the worker (`payments.processProviderEvent`) |
| Operations | `plumbus payments doctor`, `plumbus payments webhooks setup`, `plumbus payments catalog sync` / `check` |
| Amounts | `field.bigint()` columns (core 0.7.7+), integers in minor units |

There is no `ctx.payments`: app code calls the payments capabilities (browser via the generated client, server via `ctx.capabilities.invoke`), uses the helpers on the `payments` object, and reads the entities through `ctx.data`.

## Packages

| Package | Contents |
|---|---|
| `@plumbus/payments` | `createPayments`, capabilities, entities, events, helpers, webhook route, provider contract, `/testing` (fake provider, `deliverTestWebhook`) |
| `@plumbus/payments-stripe` | `stripeProvider()`, Stripe rules, webhook verification (snapshot + thin), billing catalog sync, `/testing` (signed events, HTTP stub) |

Agent recipes ship in `node_modules/@plumbus/payments/instructions/` and `node_modules/@plumbus/payments-stripe/instructions/`.

## Test app

[`examples/payments-connect-app`](../../examples/payments-connect-app/) is a tutoring marketplace built on these packages: tutors on the full dashboard (direct charges) and on Express (destination charges), a school platform that sells group classes and splits them between tutors, and school plans with seats, an AI-usage meter, and a feature gate. `node scripts/e2e.mjs` runs it on the real Plumbus runtime (Postgres, migrations, API + worker, outbox) against a local Stripe simulator through 28 scenarios, one or more per feature. `node scripts/dev.mjs --stripe` runs it against Stripe test mode.
