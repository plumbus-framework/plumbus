# @plumbus/payments-stripe — Agent Instructions

Stripe Connect provider for `@plumbus/payments`, on Stripe's newest APIs (Accounts v2 sellers, Checkout direct charges, snapshot + thin webhooks, API version `2026-08-26.dahlia`).

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Boundary, API version, what the adapter calls, critical rules. |
| [configure-stripe.md](./configure-stripe.md) | Keys, `stripeProvider()` options, Connect dashboards and liability rules. |
| [webhooks.md](./webhooks.md) | Event destinations, signing secrets, local forwarding with the Stripe CLI. |
| [testing.md](./testing.md) | Signed test events, the HTTP stub, and live test-mode runs. |

Requires `@plumbus/payments` **`0.2.x`** (wire it first: `node_modules/@plumbus/payments/instructions/wiring.md`).

Package quickstart: [../README.md](../README.md) · Human docs: [docs/payments/stripe.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/payments/stripe.md)
