# @plumbus/payments-stripe — Framework

`stripeProvider()` implements the `@plumbus/payments` provider contract with Stripe Connect. The app never imports `stripe` for money movement; it calls the payments capabilities.

**Peers:** `"@plumbus/core": "0.7.x"`, `"@plumbus/payments": "0.2.x"` — copy literally. The official `stripe` SDK (22.x) is a dependency of this package; do not add it to the app.

## Stripe APIs used (newest only)

| Need | Stripe API |
|---|---|
| Seller accounts | Accounts **v2** (`/v2/core/accounts`) with the `merchant` configuration, `dashboard`, `defaults.responsibilities` |
| Hosted onboarding | Account Links **v2** (`/v2/core/account_links`, `account_onboarding`) |
| Embedded seller components | Account Sessions (`/v1/account_sessions`) |
| Express dashboard link | Login Links (`/v1/accounts/:id/login_links`) |
| Charges | Checkout Sessions (`/v1/checkout/sessions`, `mode: payment`) on the seller account (`Stripe-Account`), `payment_intent_data.application_fee_amount` |
| Clients | Customers on the seller account |
| Refunds | Refunds on the seller account (`refund_application_fee` from config) |
| Account webhooks | **Thin** v2 events `v2.core.account…` via an event destination (`@self`) |
| Payment webhooks | **Snapshot** events from sellers' accounts via an event destination (`@accounts`) |
| Destinations | Event Destinations **v2** (`plumbus payments webhooks setup`) |

Pinned API version: `STRIPE_API_VERSION` (`2026-08-26.dahlia`). Snapshot destinations must render events in this version; `doctor` checks it. Not supported, by design: OAuth "connect an existing Stripe account" (v1-only), legacy Standard/Express/Custom account types, private-preview features.

## Public exports

```ts
import {
  stripeProvider,
  STRIPE_API_VERSION,
  STRIPE_SNAPSHOT_EVENTS,
  STRIPE_THIN_EVENTS,
  STRIPE_DESTINATION_NAMES,
} from '@plumbus/payments-stripe';
import {
  signStripeWebhook,
  stripeSnapshotEvent,
  stripeThinAccountEvent,
  createStripeHttpStub,
} from '@plumbus/payments-stripe/testing';
```

`(await provider.client())` returns the configured `Stripe` instance for Stripe-only reads the neutral API does not cover. Do not use it to create charges, refunds, or accounts.

## Critical rules

1. **Stripe rules are enforced at startup:** Express needs `fees: 'platform'` and `losses: 'platform'`; `losses: 'platform'` always needs `fees: 'platform'`.
2. **Keys are read on first use.** Pass `secretKey` / `webhookSecrets` as functions reading env or a secret manager; the mode (live/test) comes from the key prefix, and events from the other mode are ignored.
3. **Both destinations sign with their own secret.** Pass every secret in `webhookSecrets` (plus the old ones during a rotation).
4. **Stripe errors keep Stripe's message.** Invalid requests surface as `validation` errors with `metadata.stripeCode`; outages as retryable `internal` errors.
5. **Only payments created through `createCharge` are tracked.** Payments a seller makes in their own dashboard are ignored (their refunds/disputes too, unless the charge is ours).
