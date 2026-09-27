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
- Prefer a **restricted key** (`rk_…`). It needs write access to Connect accounts, account links, account sessions, login links, Checkout Sessions, Customers, Refunds, and event destinations (setup only), and read access to Payment Intents, Charges, and Disputes — on connected accounts too. Run `plumbus payments doctor --live` after creating it.
- A test key (`sk_test_`/`rk_test_`) with `NODE_ENV=production` is reported as an error by `doctor`.

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

## Dashboard links

- `full`: `openMerchantDashboard` returns `https://dashboard.stripe.com/` (sellers sign in with their own Stripe login).
- `express`: a one-time Express login link.
- `none`: not available — use embedded components.
