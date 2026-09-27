# @plumbus/payments-stripe — Framework

`stripeProvider()` implements the `@plumbus/payments` provider contract with Stripe Connect and Stripe Billing. The app never imports `stripe` for money movement; it calls the payments capabilities and helpers.

**Peers:** `"@plumbus/core": "0.7.x"`, `"@plumbus/payments": "0.2.x"` — copy literally. The official `stripe` SDK (22.x) is a dependency of this package; do not add it to the app.

## Stripe APIs used (newest only)

| Need | Stripe API |
|---|---|
| Seller accounts | Accounts **v2** (`/v2/core/accounts`): `merchant` configuration (card payments, direct charges) and/or `recipient` configuration (`stripe_transfers`, destination charges and transfers), `dashboard`, `defaults.responsibilities` |
| Hosted onboarding | Account Links **v2** (`/v2/core/account_links`, `account_onboarding`, every applied configuration) |
| Embedded seller components | Account Sessions (`/v1/account_sessions`) |
| Express dashboard link | Login Links (`/v1/accounts/:id/login_links`) |
| Payment pages | Checkout Sessions (`mode: payment`, `ui_mode: hosted_page \| embedded_page`): direct charges on the seller account (`Stripe-Account`) with `application_fee_amount`; destination charges on the platform with `transfer_data.destination` (+ `on_behalf_of`); platform charges with `transfer_group` |
| Custom amounts | Prices with `custom_unit_amount` |
| Holds and saved cards | `capture_method: manual`, `setup_future_usage: off_session`, off-session PaymentIntents, capture and cancel |
| Card-saving pages | Checkout Sessions `mode: setup`; Payment Methods list/detach |
| Invoices | Invoices (`send_invoice`) + Invoice Items, finalize, send, void; Invoice Payments |
| Payment links | Payment Links |
| Subscriptions | Checkout Sessions `mode: subscription`, Subscriptions update/cancel |
| Client and billing portals | Billing Portal sessions (a configuration is made when an account has none) |
| Transfers | Transfers (`source_transaction`), transfer reversals |
| Payouts | Balance Settings (schedule, delay), Balance (`instant_available`), Payouts |
| Disputes | Disputes update (evidence, submit) and close |
| Your plans | Products (stable ids), Prices by lookup key, Entitlement Features, Product Features, Active Entitlements, Billing Meters and meter events |
| Clients and billing customers | Customers (on the seller account for direct charges, on the platform otherwise) |
| Refunds | Refunds (`refund_application_fee`, `reverse_transfer` for destination charges) |
| Account webhooks | **Thin** v2 events `v2.core.account…` via an event destination (`@self`) |
| Everything else | **Snapshot** events from the platform (`@self`) and sellers' accounts (`@accounts`) via one event destination |
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

`(await provider.client())` returns the configured `Stripe` instance for Stripe-only reads the neutral API does not cover. Do not use it to create charges, refunds, transfers, subscriptions, or accounts.

## Critical rules

1. **Stripe rules are enforced at startup:** Express needs `fees: 'platform'` and `losses: 'platform'`; `losses: 'platform'` always needs `fees: 'platform'`. Stripe's recommendations (destination charges for Express and no-dashboard sellers, direct for full) are warnings.
2. **Keys are read on first use.** Pass `secretKey` / `webhookSecrets` as functions reading env or a secret manager; the mode (live/test) comes from the key prefix, and events from the other mode are ignored.
3. **Both destinations sign with their own secret.** Pass every secret in `webhookSecrets` (plus the old ones during a rotation).
4. **Stripe errors keep Stripe's message.** Invalid requests surface as `validation` errors with `metadata.stripeCode`; outages as retryable `internal` errors.
5. **Only objects created through this package are tracked.** Payments a seller makes in their own dashboard are ignored (their refunds/disputes too, unless the charge is ours), and so are platform objects without this package's metadata.
6. **Run `plumbus payments catalog sync` after changing `billing`.** Subscriptions to plans find their prices by lookup key; a missing one fails with `stripe_price_missing`.
