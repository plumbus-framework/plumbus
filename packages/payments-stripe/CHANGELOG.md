# Changelog

## 0.2.0 — 2026-09-27

### Added

- First release, in the core 0.7.x family. `stripeProvider()` implements the `@plumbus/payments` provider contract with Stripe Connect on Stripe's newest APIs, pinned to API version `2026-08-26.dahlia` (`stripe` 22.x).
- Sellers as Accounts v2 connected accounts (merchant configuration, `dashboard`, `defaults.responsibilities`), v2 Account Links onboarding, Account Sessions for embedded components, Express login links.
- Direct charges through Checkout on the seller account with `application_fee_amount`; customers and refunds on the seller account.
- Webhooks: snapshot events from connected accounts and thin v2 account events, verified against several signing secrets; fetch-on-event resolution for accounts, checkout sessions, refunds, and disputes.
- Stripe Connect rules at startup (Express requires platform fees and losses; platform losses require platform fees), warnings for platform liability and Radar limits.
- `plumbus payments webhooks setup` (two event destinations) and `plumbus payments doctor --live` checks (key mode, Accounts v2 access, destinations, events, API version); with `--webhook-url` it checks the destination at that URL and warns about same-named leftovers.
- Checkout `expires_at` stays a minute inside Stripe's 30-minute–24-hour window; product names are cut without splitting an emoji (a half surrogate pair made the SDK throw `URI malformed`); fee and refunded amount are reported as unknown when Stripe did not expand them, so an unpaid expired session keeps its stored fee; refund changes follow their charge.
- Stripe errors become PlumbusErrors that keep Stripe's message and codes.
- `@plumbus/payments-stripe/testing`: `signStripeWebhook`, `stripeSnapshotEvent`, `stripeThinAccountEvent`, `createStripeHttpStub`.
