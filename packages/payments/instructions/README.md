# @plumbus/payments — Agent Instructions

Provider-neutral payments for Plumbus apps: **sellers (users or tenants) connect their own payment-provider account and charge their clients**; your platform can take a cut. Install a provider package too — today that is `@plumbus/payments-stripe`.

Read in this order:

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. What the package does, public exports, file map, critical rules. |
| [wiring.md](./wiring.md) | Adding payments to an app: `app/payments/index.ts`, re-exports, webhook route, worker, migrations. |
| [options.md](./options.md) | Choosing `createPayments()` options: seller owner, dashboards, fees, losses, platform fee, onboarding. |
| [capabilities-and-events.md](./capabilities-and-events.md) | Calling the payments capabilities from UI or app code, reacting to `payments.*` events. |
| [testing.md](./testing.md) | Tests with the fake provider, `createPaymentsTestContext`, and `deliverTestWebhook`. |

Provider recipes: `node_modules/@plumbus/payments-stripe/instructions/README.md`.

Critical rules (details in [framework.md](./framework.md)):

1. Money moves only through the payments capabilities. Never call the provider SDK from app capabilities to create charges or refunds.
2. Grant access or deliver goods on the `payments.charge.paid` event, never on the checkout success redirect.
3. Amounts are integers in minor units (cents). The server computes the platform fee; never accept it from the browser.
4. Register every payments entity, event, and capability, and run the worker — webhooks are processed there.

Human docs: [docs/payments/](https://github.com/plumbus-framework/plumbus/tree/main/docs/payments) · Package README: [../README.md](../README.md)
