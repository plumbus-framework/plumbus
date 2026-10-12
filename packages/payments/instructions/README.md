# @plumbus/payments — Agent Instructions

Provider-neutral payments for Plumbus apps: **sellers (users or tenants) connect their own payment-provider account and charge their clients** (your platform can take a cut, hold the money, split it, or pay it out), and **your app bills its own customers** for plans, seats, and usage. Install a provider package too — today that is `@plumbus/payments-stripe`.

Read in this order:

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. What the package does, public exports, file map, critical rules. |
| [wiring.md](./wiring.md) | Adding payments to an app: `app/payments/index.ts`, collection exports, webhook route, worker, migrations, catalog sync, helpers in your own capabilities. |
| [options.md](./options.md) | Choosing `createPayments()` options: sellers or billing, dashboards, charge type, fees, losses, platform fee, payment pages, invoices, subscriptions, payouts, plans and meters. |
| [capabilities-and-events.md](./capabilities-and-events.md) | Calling the payments capabilities and helpers from UI or app code, reacting to `payments.*` events. |
| [testing.md](./testing.md) | Tests with the fake provider, `createPaymentsTestContext`, and `deliverTestWebhook`. |

Provider recipes: `node_modules/@plumbus/payments-stripe/instructions/README.md`.

Critical rules (details in [framework.md](./framework.md)):

1. Money moves only through the payments capabilities. Never call the provider SDK from app capabilities to create charges or refunds.
2. Grant access or deliver goods on the `payments.charge.paid` event, never on the checkout success redirect.
3. Amounts are integers in minor units (cents). The server computes the platform fee; never accept it from the browser.
4. Register every payments entity, event, and capability (`paymentEntities`, `paymentEvents`, `payments.capabilities`), and run the worker — webhooks are processed there.
5. Gate paid features on the server with `payments.billing.hasFeature`, and run `plumbus payments catalog sync` after changing `billing`.

Human docs: [docs/payments/](https://github.com/plumbus-framework/plumbus/tree/main/docs/payments) · Package README: [../README.md](../README.md)
