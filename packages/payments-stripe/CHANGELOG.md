# Changelog

## 0.2.1 — 2026-09-28

### Fixed

- A customer Stripe no longer has (`resource_missing` on `customer`, or "No such customer") is reported with `reason: 'payments_provider_customer_missing'` instead of `stripe_error`, so `@plumbus/payments` 0.2.1 replaces the billing customer and retries instead of failing every checkout after a switch of Stripe account.

- A platform without sellers (only `billing`, e.g. one-off purchases) no longer needs Stripe Connect. `plumbus payments webhooks setup` created a snapshot destination taking events from `@accounts` and a thin destination for v2 account events, and `doctor --live` reported an error when the key could not use Accounts v2 and warned when fewer than two signing secrets were set. Neither applies to an account with no connected accounts. Now, when the config has no `seller` (passed by `@plumbus/payments` 0.2.1 as `sellers: false`), setup creates one snapshot destination from `@self` with the platform's events (`STRIPE_PLATFORM_SNAPSHOT_EVENTS`: no transfer or payout events), and doctor checks only that destination and one signing secret, and skips the Accounts v2 check. Apps with sellers, and callers that do not pass `sellers`, get the two destinations as before.

## 0.2.0 — 2026-09-27

### Added

- First release, in the core 0.7.x family. `stripeProvider()` implements the `@plumbus/payments` provider contract with Stripe Connect on Stripe's newest APIs, pinned to API version `2026-08-26.dahlia` (`stripe` 22.x).
- Sellers as Accounts v2 connected accounts (merchant configuration, `dashboard`, `defaults.responsibilities`), v2 Account Links onboarding, Account Sessions for embedded components, Express login links.
- Direct charges through Checkout on the seller account with `application_fee_amount`; customers and refunds on the seller account.
- Webhooks: snapshot events from connected accounts and thin v2 account events, verified against several signing secrets; fetch-on-event resolution for accounts, checkout sessions, refunds, and disputes.
- Stripe Connect rules at startup (Express requires platform fees and losses; platform losses require platform fees), warnings for platform liability and Radar limits.
- `plumbus payments webhooks setup` (two event destinations) and `plumbus payments doctor --live` checks (key mode, Accounts v2 access, destinations, events, API version); with `--webhook-url` it checks the destination at that URL and warns about same-named leftovers.
- Checkout `expires_at` stays a minute inside Stripe's 30-minute–24-hour window; product names are cut without splitting an emoji (a half surrogate pair made the SDK throw `URI malformed`); fee and refunded amount are reported as unknown when Stripe did not expand them, so an unpaid expired session keeps its stored fee; refund changes follow their charge; `findRefund` looks a refund up by its `plumbus_refund_id` on the seller's account.
- Stripe errors become PlumbusErrors that keep Stripe's message and codes.
- Charge types and routing: destination charges on the platform (`transfer_data.destination`, `on_behalf_of`), platform charges (`transfer_group`); accounts ask for the recipient configuration (`stripe_transfers`) as needed and onboarding links cover every applied configuration; `transfersEnabled` from the recipient capability; refunds with `reverse_transfer`.
- Checkout: line items, custom amounts (a `custom_unit_amount` price), embedded pages (`ui_mode: embedded_page`), holds (`capture_method: manual`), saving the method (`setup_future_usage`), and page options (promotion codes, Stripe Tax with `customer_update.address`, billing address, phone, shipping countries, locale, submit type, statement descriptor suffix); discounts, tax, captured amounts, and saved methods read back from sessions.
- Invoices (created, filled, finalized, sent; an invoice a crashed attempt left behind is finished, not made twice), off-session charges on saved cards (declines and `authentication_required` become outcomes), capture and cancel, card-saving pages, payment method list/detach, client and billing portals (a portal configuration is made for an account that has none), subscriptions through Checkout (inline prices or catalog prices by lookup key, `application_fee_percent`), payment links, transfers (`source_transaction`) and reversals, payouts through Balance Settings (schedules, delay) and instant payouts, dispute evidence and acceptance.
- Stripe Billing: `syncCatalog` / `checkCatalog` for products (stable ids), prices by lookup key (`transfer_lookup_key` on a change, the old price archived), entitlement features attached to plan products, and billing meters with metered prices; billing customers, active entitlements, and meter events.
- Webhooks: one snapshot destination from `@self` and `@accounts` with payment intent, payment method, subscription, invoice, transfer, payout, and entitlement events; recipient thin events; routing hints for platform events; `resolveEvent` for every new object, resolving a payment to the page or invoice it belongs to. `webhooks setup` adds missing events to existing destinations and makes a new snapshot destination when an old one lacks `@self`; `doctor --live` reports missing sources, which duplicate to delete, and an out-of-date catalog.
- Config rules: Stripe's charge-type recommendations (destination for Express and no-dashboard sellers, direct for full) and platform liability for destination charges as warnings.
- `@plumbus/payments-stripe/testing`: `signStripeWebhook`, `stripeSnapshotEvent`, `stripeThinAccountEvent`, `createStripeHttpStub`.
