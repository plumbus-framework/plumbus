# Configuring stripeProvider()

## Stripe account prerequisites

1. A Stripe account with **Connect** enabled and the platform profile completed (Dashboard → Connect). Test mode works immediately; live mode needs Stripe's review.
2. Accounts v2 available to the platform (`plumbus payments doctor --live` reports `stripe_accounts_v2_unavailable` otherwise).

## Options

```ts
stripeProvider({
  secretKey: () => process.env.STRIPE_SECRET_KEY ?? '',          // sk_… or rk_… (required)
  webhookSecrets: () => (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean), // required
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,            // only for embedded components
  webhookToleranceSeconds: 300,                                  // signature age limit
  maxNetworkRetries: 2,                                          // SDK retries on network/409/429/5xx
  timeoutMs: 80_000,
  // api: { host: 'localhost', port: 12111, protocol: 'http' }, // stripe-mock
});
```

- The API **and** worker processes both need `STRIPE_SECRET_KEY` (the worker re-reads Stripe for every webhook) and the API needs `STRIPE_WEBHOOK_SECRETS`.
- Prefer a **restricted key** (`rk_…`). It needs write access, on connected accounts too, to what your config uses: Connect accounts, account links, account sessions, login links, Checkout Sessions, Customers, Payment Intents (holds, saved cards), Payment Methods, Refunds, Disputes (answering), Invoices and Invoice Items, Payment Links, Prices (custom amounts), Subscriptions, Billing Portal, Transfers, Payouts and Balance Settings; for `billing`, Products, Prices, Entitlement Features, and Billing Meters; event destinations (setup only); and read access to Charges, Balance, Invoice Payments, and Active Entitlements. Run `plumbus payments doctor --live` after creating it.
- A test key (`sk_test_`/`rk_test_`) with `NODE_ENV=production` is reported as an error by `doctor`.
- Checkout pages live 31 minutes to 23 h 59 min: `checkout.expiresAfterMinutes` is kept a minute inside Stripe's 30-minute–24-hour window.
- Embedded payment pages (`checkout.ui: 'embedded'`) need `publishableKey`; the front end mounts them with Stripe.js `initEmbeddedCheckout`, initialised with `stripeAccount: charge.checkout.accountId` when set (direct charges).

## Dashboards, fees, and losses (Stripe Accounts v2)

`createPayments({ dashboards })` maps to Stripe's `dashboard` and `defaults.responsibilities`:

| payments option | Stripe field |
|---|---|
| `dashboards.full` / `express` / `none` | `dashboard: 'full' \| 'express' \| 'none'` |
| `fees: 'provider'` / `'platform'` | `fees_collector: 'stripe'` / `'application'` |
| `losses: 'provider'` / `'platform'` | `losses_collector: 'stripe'` / `'application'` |

What each combination means:

- **full + provider/provider** (default): the seller has the full Stripe Dashboard, pays Stripe's fees, and Stripe covers negative balances. No Connect fees for the platform. Lowest risk.
- **express** (always platform/platform): lighter Stripe-hosted dashboard; your platform pays Stripe's processing fees and Connect fees and covers losses. Set `platformFee` to include Stripe's fee, or you lose money per charge.
- **none**: no Stripe dashboard; render Stripe's embedded components via `createMerchantSession`. With platform losses you are also responsible for collecting seller identity requirements.
- `fees: 'platform'` on full/none: Stripe bills your platform; your `platformFee` must include Stripe's processing fee.
- Sellers on express/none cannot write their own Radar rules, and platform Radar rules do not apply to direct charges — set rules per seller from "View Dashboard as this account".

These settings are fixed per seller when the account is created. Ask the app owner before offering `express` or platform liability: it moves financial risk to them.

## Charge types

| `chargeType` | Stripe | Seller's account asks for |
|---|---|---|
| `direct` (default for `full`) | Checkout on the seller's account, `application_fee_amount` | `merchant.card_payments` |
| `destination` (default for `express`, `none`) | Checkout on the platform, `transfer_data.destination`, `application_fee_amount` | `recipient.stripe_balance.stripe_transfers` (+ `card_payments` with `destination.onBehalfOf`, which sets `on_behalf_of`) |

`transfers.enabled` adds `stripe_transfers` for every seller so `payments.platform.transferToSeller` can pay them. Stripe restricts transfers across regions; check Stripe's cross-border payouts before selling internationally.

## Payouts

`payouts.schedule` is written through Stripe's **Balance Settings** API when an Express or no-dashboard seller's account is created (Stripe lets platforms set payout schedules only for accounts whose losses they cover). Weekly payouts go out Monday to Friday; `delayDays` becomes `settlement_timing.delay_days_override` (0–31, `'minimum'` resets it). Instant payouts need an eligible debit card on the seller's account; `getPayoutSettings` reports `instantAvailable` from the seller's balance.

## The billing catalog

`plumbus payments catalog sync` creates, for each plan, a product with a stable id (`plumbus_plan_…`, derived from `appId` and the plan key), a price per plan price with lookup key `plumbus:<appId>:<plan>:<price>`, an entitlement feature per feature key (`plumbus:<appId>:feature:<key>`) attached to its plans' products, and for each meter a billing meter (by `eventName`, mapping `stripe_customer_id` and `value`), a product, and a metered price (`plumbus:<appId>:meter:<meter>`). A changed amount makes a new price with `transfer_lookup_key` and archives the old one. A meter's aggregation cannot change at Stripe: use a new `eventName`. `catalog check` and `doctor --live` report differences without changing anything.

## Dashboard links

- `full`: `openMerchantDashboard` returns `https://dashboard.stripe.com/` (sellers sign in with their own Stripe login).
- `express`: a one-time Express login link.
- `none`: not available — use embedded components.
