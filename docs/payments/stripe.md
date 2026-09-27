# Stripe provider

**Previous:** [billing.md](./billing.md) · **Next:** [webhooks.md](./webhooks.md)

`@plumbus/payments-stripe` implements the payments provider contract with Stripe Connect (sellers) and Stripe Billing (your plans), using only Stripe's newest APIs. It depends on the official `stripe` Node SDK (22.x), pinned to API version **`2026-08-26.dahlia`** (`STRIPE_API_VERSION`).

## Where objects live

| Charge type / feature | Stripe account | Request |
|---|---|---|
| Direct charges, their customers, refunds, disputes, subscriptions, links, invoices | The seller's connected account | `Stripe-Account: acct_…` |
| Destination charges and their customers, refunds, disputes, subscriptions, links, invoices | Your platform | `transfer_data.destination` = the seller (and `on_behalf_of` with `destination.onBehalfOf`) |
| Platform charges, transfers, your plans, billing customers, meters, entitlements | Your platform | — |
| Payouts and payout settings | The seller's connected account | `Stripe-Account` |

## What each capability calls

| Capability / helper | Stripe |
|---|---|
| `startMerchantOnboarding` (first call) | `POST /v2/core/accounts` — `dashboard`, `identity.country`, `configuration.merchant.capabilities.card_payments.requested` (direct charges, or `onBehalfOf`) and/or `configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested` (destination charges, transfers), `defaults.responsibilities.{fees,losses}_collector`, metadata, `Idempotency-Key`; then, with `payouts.schedule`, `POST /v1/balance_settings` on the new account |
| `startMerchantOnboarding` (link) | `POST /v2/core/account_links` — `use_case.type: account_onboarding`, `configurations` = the account's applied configurations (`merchant`, `recipient`), return/refresh URLs, `collection_options.fields` |
| `syncMerchantAccount` | `GET /v2/core/accounts/:id?include=configuration.merchant,configuration.recipient,defaults,identity,requirements` |
| `createMerchantSession` | `POST /v1/account_sessions` with the chosen components |
| `openMerchantDashboard` | Express: `POST /v1/accounts/:id/login_links`; full: `https://dashboard.stripe.com/` |
| `createCharge` (page) | `POST /v1/customers` (first time per client) and `POST /v1/checkout/sessions`: `mode: payment`, `ui_mode: hosted_page \| embedded_page`, one `price_data` line per item, `client_reference_id`, `payment_intent_data` (`application_fee_amount`, `transfer_data`, `on_behalf_of`, `transfer_group`, `capture_method: manual`, `setup_future_usage: off_session`, `statement_descriptor_suffix`), page options (`allow_promotion_codes`, `automatic_tax` + `customer_update.address`, `billing_address_collection`, `phone_number_collection`, `shipping_address_collection`, `locale`, `submit_type`), `expires_at`. A custom amount first creates a price with `custom_unit_amount` |
| `createCharge` (invoice) | `POST /v1/invoices` (`collection_method: send_invoice`, `days_until_due`, fee/transfer fields), `POST /v1/invoiceitems` per item, `POST /v1/invoices/:id/finalize`, `POST /v1/invoices/:id/send`. An earlier attempt's invoice (found by the charge id in its metadata) is finished instead of made twice |
| `chargeSavedMethod` | `POST /v1/payment_intents` with `off_session`, `confirm`, the saved `payment_method`; a `card_error` (declined, `authentication_required`) becomes a `failed` / `requires_action` charge, not an error |
| `captureCharge` | `POST /v1/payment_intents/:id/capture` (`amount_to_capture`, `application_fee_amount`) |
| `cancelCharge` | Open page: `POST /v1/checkout/sessions/:id/expire`; hold: `POST /v1/payment_intents/:id/cancel`; invoice: `POST /v1/invoices/:id/void` |
| `refundCharge` | `POST /v1/refunds` — `refund_application_fee` from config; `reverse_transfer` for destination charges |
| `saveClientPaymentMethod` | `POST /v1/checkout/sessions` with `mode: setup` (cards) |
| `listClientPaymentMethods` / `sync…` / `remove…` | `GET /v1/customers/:id/payment_methods`, `POST /v1/payment_methods/:id/detach` |
| `createClientPortalSession`, `openBillingPortal` | `POST /v1/billing_portal/sessions`; an account without a portal configuration gets one first (`POST /v1/billing_portal/configurations`: invoices, payment method, cancel at period end) |
| `createSubscription`, `subscribeToPlan` | `POST /v1/checkout/sessions` with `mode: subscription`: inline recurring `price_data`, or catalog prices found by lookup key (`GET /v1/prices?lookup_keys[]=…`); `subscription_data` (`application_fee_percent`, `transfer_data`, `on_behalf_of`, `trial_period_days`, metadata) |
| `cancelSubscription`, `resumeSubscription`, `changePlan`, `setSeats` | `POST /v1/subscriptions/:id` (`cancel_at_period_end`, `items`, `proration_behavior`) or `DELETE /v1/subscriptions/:id` |
| `createPaymentLink`, `setPaymentLinkActive` | `POST /v1/payment_links` (`price_data` lines, `adjustable_quantity`, fee/transfer fields, `after_completion` redirect), `POST /v1/payment_links/:id` |
| `transferToSeller`, `reverseTransfer` | `POST /v1/transfers` (`source_transaction` = the charge's Stripe charge), `POST /v1/transfers/:id/reversals` |
| `getPayoutSettings`, `updatePayoutSchedule` | `GET` / `POST /v1/balance_settings` (the Balance Settings API manages payouts of Accounts v2 sellers) and `GET /v1/balance` (`instant_available`) |
| `createInstantPayout`, `listPayouts` | `POST /v1/payouts` (`method: instant`), `GET /v1/payouts` |
| `respondToDispute`, `acceptDispute` | `POST /v1/disputes/:id` (`evidence`, `submit`), `POST /v1/disputes/:id/close`. Policy texts go into `refund_policy_disclosure` / `cancellation_policy_disclosure` (the file fields take uploads) |
| Billing customers | `POST /v1/customers` on the platform |
| `recordUsage`, `aiUsageBridge` | `POST /v1/billing/meter_events` (`payload.stripe_customer_id`, `payload.value`, `identifier`, `timestamp`) |
| Entitlements | `GET /v1/entitlements/active_entitlements?customer=…` |
| `plumbus payments catalog sync` / `check` | Products (`GET/POST /v1/products/:id`), prices by lookup key (`transfer_lookup_key` on a change, the old one archived), entitlement features and product features, billing meters |

Account status mapping: `chargesEnabled` = merchant `card_payments` `active`; `transfersEnabled` = recipient `stripe_transfers` `active`; `payoutsEnabled` = `stripe_balance.payouts` `active`; `requirementsDue` / `requirementsPastDue` = requirement entries awaiting the seller that are `currently_due`/`past_due`; `disabledReason` = the status detail of the capability the seller is paid through when restricted.

Charge status mapping: Checkout Session `open` → `open`, `expired` → `expired`; `complete` with the PaymentIntent `requires_capture` → `authorized`, `succeeded` → `paid`, `canceled` → `canceled`, `requires_payment_method` → `failed`, otherwise `processing`. An off-session PaymentIntent maps directly (`requires_action` or an `authentication_required` error → `requires_action`). Invoices: `open` → `open`, `paid` → `paid`, `void` → `canceled`, `uncollectible` → `failed`. A partial capture's `amountTotal` is the captured amount.

## Keys

- `secretKey`: `sk_…` or, preferably, a restricted `rk_…` key. Live/test mode comes from the prefix; events from the other mode are ignored. The worker needs the key too (it re-reads Stripe per event).
- `webhookSecrets`: all destination secrets (two in production, one from `stripe listen` locally), plus old ones during rotation.
- `publishableKey`: returned with merchant sessions for Stripe's embedded components (`@stripe/connect-js`) and with embedded payment pages (`charge.checkout.publishableKey`, for Stripe.js).

`plumbus payments doctor --live` reports: test key in production, live key outside production, restricted-key hint, missing/incomplete webhook secrets, Accounts v2 unavailable (Connect not set up), missing/disabled destinations, wrong URL, a snapshot destination that takes no platform (`@self`) events, missing event types, snapshot API version drift, several destinations with the same name (saying which to keep and which to delete), and, with `billing`, an out-of-date catalog. With `--webhook-url`, the destination at that URL is the one checked.

## Checkout sessions

- `expires_at` is kept between 31 minutes and 23 h 59 min after the request. Stripe accepts 30 minutes to 24 hours measured from when *it* creates the session, so the minute on each side absorbs request time and clock skew; `checkout.expiresAfterMinutes: 30` gives 31-minute pages and `1440` gives 23 h 59 min.
- Item names on the page are cut to 250 characters, never in the middle of an emoji (half a surrogate pair cannot be sent).
- Embedded pages use `ui_mode: embedded_page` and `return_url`; the client secret is only returned while the page is open.
- The card-saving page takes cards only: Stripe needs a currency for other methods on setup pages, and saving is not tied to a currency.

## Stripe rules the config enforces

From Stripe's Accounts v2 reference and Connect guides:

- `dashboard: 'express'` requires `fees_collector: 'application'` and `losses_collector: 'application'` (error `account_controller_express_dash_without_application_losses_or_fees`).
- `losses_collector: 'application'` requires `fees_collector: 'application'`.
- Responsibilities cannot change after an account is created.
- With `fees_collector: 'stripe'`, Stripe charges the seller directly for their direct charges and no Connect fees apply to the platform; with `'application'`, the platform pays Stripe's processing and Connect fees, and the application fee should include Stripe's fee. On destination charges Stripe always bills the platform.
- Stripe recommends direct charges for full-dashboard sellers and destination charges with platform fees and losses for Express and no-dashboard sellers (warnings, and an info note for `none`, where platform losses also make the platform collect identity requirements).
- For direct charges, Stripe recommends Stripe-covered losses; platform-covered losses can make Stripe hold a reserve on the platform balance.
- Sellers without the full dashboard can't write their own Radar rules, and platform Radar rules don't apply to direct charges.
- Payout schedules: weekly payouts on Monday to Friday; `delay_days_override` 0–31; the platform sets schedules only for accounts whose losses it covers.

## Errors

Stripe errors become PlumbusErrors that keep Stripe's message: invalid requests and card errors → `validation` (with `metadata.stripeCode`, `param`, `requestId`); idempotency conflicts → `conflict`; authentication/permission → `internal` ("Stripe rejected the platform credentials"); outages and rate limits → `internal` with `metadata.retryable: true`. A missing catalog price is `validation` with `reason: 'stripe_price_missing'` and the lookup keys ("run plumbus payments catalog sync").

## Not supported, by design

OAuth ("connect an existing Stripe account" — Accounts v1 only), legacy Standard/Express/Custom account types, a custom card form (Elements with PaymentIntents), Stripe private previews. See [options.md](./options.md#choices-this-release-does-not-offer).
