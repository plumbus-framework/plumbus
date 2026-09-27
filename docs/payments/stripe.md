# Stripe Connect provider

**Previous:** [options.md](./options.md) · **Next:** [webhooks.md](./webhooks.md)

`@plumbus/payments-stripe` implements the payments provider contract with Stripe Connect, using only Stripe's newest APIs. It depends on the official `stripe` Node SDK (22.x), pinned to API version **`2026-08-26.dahlia`** (`STRIPE_API_VERSION`).

## What each capability calls

| Capability | Stripe |
|---|---|
| `startMerchantOnboarding` (first call) | `POST /v2/core/accounts` — `dashboard`, `identity.country`, `configuration.merchant.capabilities.card_payments.requested`, `defaults.responsibilities.{fees,losses}_collector`, metadata, `Idempotency-Key` |
| `startMerchantOnboarding` (link) | `POST /v2/core/account_links` — `use_case.type: account_onboarding`, `configurations: ['merchant']`, return/refresh URLs, `collection_options.fields` |
| `syncMerchantAccount` | `GET /v2/core/accounts/:id?include=configuration.merchant,defaults,identity,requirements` |
| `createMerchantSession` | `POST /v1/account_sessions` with the chosen components (`account_onboarding`, `payments`, `payouts`, `notification_banner`, `account_management`, `balances`, `disputes_list`, `documents`) |
| `openMerchantDashboard` | Express: `POST /v1/accounts/:id/login_links`; full: `https://dashboard.stripe.com/` |
| `createCharge` | `POST /v1/customers` (first time per client) and `POST /v1/checkout/sessions` on the seller account (`Stripe-Account`): `mode: payment`, one `price_data` line, `client_reference_id`, `payment_intent_data.application_fee_amount`, `expires_at` |
| `refundCharge` | `POST /v1/refunds` on the seller account, `refund_application_fee` from config |

Account status mapping: `chargesEnabled` = merchant `card_payments` capability `active`; `payoutsEnabled` = `stripe_balance.payouts` `active`; `requirementsDue` / `requirementsPastDue` = requirement entries awaiting the seller that are `currently_due`/`past_due`; `disabledReason` = the card capability's status detail when restricted.

Charge status mapping (Checkout Session + PaymentIntent): `open` → `open`; `expired` → `expired`; `complete` + `paid` → `paid`; `complete` + unpaid with a processing PaymentIntent → `processing`; PaymentIntent `requires_payment_method`/`canceled` → `failed`.

## Keys

- `secretKey`: `sk_…` or, preferably, a restricted `rk_…` key. Live/test mode comes from the prefix; events from the other mode are ignored. The worker needs the key too (it re-reads Stripe per event).
- `webhookSecrets`: all destination secrets (two in production, one from `stripe listen` locally), plus old ones during rotation.
- `publishableKey`: returned with merchant sessions for Stripe's embedded components (`@stripe/connect-js`).

`plumbus payments doctor --live` reports: test key in production, live key outside production, restricted-key hint, missing/incomplete webhook secrets, Accounts v2 unavailable (Connect not set up), missing/disabled destinations, wrong URL, missing event types, snapshot API version drift, and (as a warning) several destinations with the same name, e.g. one left at an old URL after running `webhooks setup` with a new one. With `--webhook-url`, the destination at that URL is the one checked.

## Checkout sessions

- `expires_at` is kept between 31 minutes and 23 h 59 min after the request. Stripe accepts 30 minutes to 24 hours measured from when *it* creates the session, so the minute on each side absorbs request time and clock skew; `checkout.expiresAfterMinutes: 30` gives 31-minute links and `1440` gives 23 h 59 min.
- The product name on the payment page is the charge description cut to 250 characters, never in the middle of an emoji (half a surrogate pair cannot be sent).

## Stripe rules the config enforces

From Stripe's Accounts v2 reference and Connect guides:

- `dashboard: 'express'` requires `fees_collector: 'application'` and `losses_collector: 'application'` (error `account_controller_express_dash_without_application_losses_or_fees`).
- `losses_collector: 'application'` requires `fees_collector: 'application'`.
- Responsibilities cannot change after an account is created.
- With `fees_collector: 'stripe'`, Stripe charges the seller directly and no Connect fees apply to the platform; with `'application'`, the platform pays Stripe's processing and Connect fees, and the application fee should include Stripe's fee.
- For direct charges, Stripe recommends Stripe-covered losses; platform-covered losses can make Stripe hold a reserve on the platform balance.
- Sellers without the full dashboard can't write their own Radar rules, and platform Radar rules don't apply to direct charges.

## Errors

Stripe errors become PlumbusErrors that keep Stripe's message: invalid requests and card errors → `validation` (with `metadata.stripeCode`, `param`, `requestId`); idempotency conflicts → `conflict`; authentication/permission → `internal` ("Stripe rejected the platform credentials"); outages and rate limits → `internal` with `metadata.retryable: true`.

## Not supported, by design

OAuth ("connect an existing Stripe account" — Accounts v1 only), legacy Standard/Express/Custom account types, destination and separate charges (planned), Stripe private previews. See [options.md](./options.md#choices-not-available-in-this-release).
