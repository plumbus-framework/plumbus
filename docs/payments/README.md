# Payments

`@plumbus/payments` lets the people who use your app **charge their own clients** — tutors charging students, clinics charging patients, shops charging customers — with your app as the platform in between and an optional cut for you. `@plumbus/payments-stripe` connects it to **Stripe Connect** on Stripe's newest APIs.

| Doc | Read when |
|---|---|
| [getting-started.md](./getting-started.md) | Adding payments to an app, step by step |
| [options.md](./options.md) | Choosing every option — who covers losses, dashboards, fees, onboarding, countries — and what is not available yet |
| [stripe.md](./stripe.md) | Stripe specifics: Accounts v2, API version, keys, what each call does |
| [webhooks.md](./webhooks.md) | How webhooks are received, verified, deduplicated, and applied |
| [testing.md](./testing.md) | Fake provider, signed Stripe events, HTTP stub, smoke app |
| [security.md](./security.md) | Threat model and the rules the packages enforce |

## How it fits Plumbus

| Concern | Where |
|---|---|
| Money movement | Capabilities (`payments.createCharge`, `payments.refundCharge`, …) — access policies, audit, idempotency |
| State | Entities (`PaymentMerchantAccount`, `PaymentCharge`, …) mirroring the provider, tenant-scoped |
| Reactions | Events (`payments.charge.paid`, `payments.dispute.opened`, …) handled by your `eventHandler` capabilities |
| Webhooks | `registerPaymentRoutes()` in `app/server.ts` + the worker (`payments.processProviderEvent`) |
| Operations | `plumbus payments doctor`, `plumbus payments webhooks setup` |
| Amounts | `field.bigint()` columns (core 0.7.7+), integers in minor units |

There is no `ctx.payments`: app code calls the payments capabilities (browser via the generated client, server via `ctx.capabilities.invoke`) and reads the entities through `ctx.data`.

## Packages

| Package | Contents |
|---|---|
| `@plumbus/payments` | `createPayments`, capabilities, entities, events, webhook route, provider contract, `/testing` (fake provider, `deliverTestWebhook`) |
| `@plumbus/payments-stripe` | `stripeProvider()`, Stripe rules, webhook verification (snapshot + thin), `/testing` (signed events, HTTP stub) |

Agent recipes ship in `node_modules/@plumbus/payments/instructions/` and `node_modules/@plumbus/payments-stripe/instructions/`.

## Test app

[`examples/payments-connect-app`](../../examples/payments-connect-app/) is a tutoring marketplace built on these packages. `node scripts/e2e.mjs` runs it on the real Plumbus runtime (Postgres, migrations, API + worker, outbox) against a local Stripe simulator through 13 scenarios; the later phases are listed there as planned, with the Stripe APIs each needs. `node scripts/dev.mjs --stripe` runs it against Stripe test mode.
