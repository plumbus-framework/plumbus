# @plumbus/payments-stripe — Agent Instructions

Stripe provider for `@plumbus/payments`, on Stripe's newest APIs: Connect for sellers (Accounts v2 with merchant and recipient configurations, direct and destination charges, transfers, payouts through Balance Settings), Checkout (hosted and embedded pages, subscriptions, saved cards), invoices, payment links, Billing for your own plans (prices by lookup key, entitlements, meters), and snapshot + thin webhooks (API version `2026-08-26.dahlia`).

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Boundary, API version, what the adapter calls, critical rules. |
| [configure-stripe.md](./configure-stripe.md) | Keys, `stripeProvider()` options, Connect dashboards, charge types, liability rules, restricted-key permissions, the billing catalog. |
| [webhooks.md](./webhooks.md) | Event destinations, signing secrets, upgrades, local forwarding with the Stripe CLI. |
| [testing.md](./testing.md) | Signed test events, the HTTP stub, and live test-mode runs. |

Requires `@plumbus/payments` **`0.2.x`** (wire it first: `node_modules/@plumbus/payments/instructions/wiring.md`).

Package quickstart: [../README.md](../README.md) · Human docs: [docs/payments/stripe.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/payments/stripe.md)
