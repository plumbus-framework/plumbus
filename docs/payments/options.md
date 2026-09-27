# Payments options — every choice, explained

**Previous:** [getting-started.md](./getting-started.md) · **Next:** [stripe.md](./stripe.md)

`@plumbus/payments` does not pick a payments setup for you. Every option below is a
`createPayments()` setting (or, at the end, a choice this release does not offer yet),
with what it means for **you** (the platform), the **seller** (your user or tenant),
and the seller's **clients**.

Two kinds of people decide:

- **The app** decides business terms in config: who covers losses, who pays fees, your cut, which dashboards and countries are offered.
- **Each seller** decides, once, among what the app offers: today that is the dashboard (when more than one is offered) and their country.

> **Permanent per seller:** the dashboard, fees and losses responsibilities, and country are fixed when the seller's provider account is created. Changing config later affects new sellers only; an existing seller who wants something else needs a new account (their past payments stay on the old one).

A test fails whenever an option is added to the code without a section here.

## Contents

1. [Provider](#provider)
2. [Who the seller is](#who-the-seller-is)
3. [Who may do what](#who-may-do-what)
4. [Dashboards, fees, and losses](#dashboards-fees-and-losses)
5. [Onboarding](#onboarding)
6. [Countries and currencies](#countries-and-currencies)
7. [Charge type](#charge-type)
8. [Your cut (platform fee)](#your-cut-platform-fee)
9. [Refunds](#refunds)
10. [Checkout links](#checkout-links)
11. [Embedded components](#embedded-components)
12. [Redirect URLs](#redirect-urls)
13. [Webhooks](#webhooks)
14. [Sharing a provider account between apps](#sharing-a-provider-account-between-apps)
15. [Choices not available in this release](#choices-not-available-in-this-release)
16. [Ready-made setups](#ready-made-setups)

---

## Provider

### `provider`

The payment-provider adapter. Today: `stripeProvider({...})` from `@plumbus/payments-stripe` (see [stripe.md](./stripe.md)). Required. The provider also supplies the defaults used when a dashboard is offered as `true`, and adds its own rules (for Stripe, the Accounts v2 combinations below).

---

## Who the seller is

### `seller`

### `seller.owner`

| Value | Meaning | Good for |
|---|---|---|
| `'user'` | Every signed-in user can connect **their own** provider account. The owner is `ctx.auth.userId`. | Tutors, freelancers, creators — individuals who get paid |
| `'tenant'` | One provider account **per tenant**, shared by everyone `access.sellers` allows. The owner is `ctx.auth.tenantId`. | Schools, clinics, shops — an organization gets paid |

Required. The owner always comes from the caller's auth; no input can act for another seller. Payments entities are tenant-scoped, so a tenant context (`auth.tenantId`) is required in both modes — single-tenant apps set a constant tenant id in their auth. Switching mode later does not migrate existing accounts.

---

## Who may do what

### `access`

### `access.sellers`

Plumbus [`AccessPolicy`](../security/security-model.md) for connecting an account, minting sessions, opening the dashboard, creating charges, and reading charges. Required. Fields:

- `access.sellers.roles` — the caller needs at least one of these roles.
- `access.sellers.scopes` — the caller needs all of these scopes.
- `access.sellers.public` — never set this for payments (anonymous callers have no owner).
- `access.sellers.tenantScoped` — require a tenant context (payments requires one anyway).
- `access.sellers.serviceAccounts` — service accounts allowed in addition; do not list `payments-webhook`.

An empty policy (`{}`) lets **any signed-in user** act as a seller for themselves.

### `access.refunds`

Policy for `refundCharge`. Defaults to `access.sellers`. Narrow it (for example `{ roles: ['finance'] }`) when only some people may give money back. Same fields: `access.refunds.roles`, `access.refunds.scopes`, `access.refunds.public`, `access.refunds.tenantScoped`, `access.refunds.serviceAccounts`.

---

## Dashboards, fees, and losses

### `dashboards`

Which provider dashboards sellers may get. Offer one or several; when several are offered, each seller picks once at onboarding (pass `dashboard` to `startMerchantOnboarding`, or set `defaultDashboard`). At least one is required.

Each offered dashboard is `true` (provider defaults) or `{ fees, losses }`:

- **fees** — who pays the provider's processing fees on the seller's charges: `'provider'` (the provider bills the seller directly) or `'platform'` (the provider bills your platform).
- **losses** — who covers negative balances when a seller cannot pay for refunds or disputes: `'provider'` or `'platform'`.

### `dashboards.full`

The seller gets the provider's **full dashboard** and manages payouts, disputes, reports, and settings there.

- `dashboards.full.fees` — default `'provider'`.
- `dashboards.full.losses` — default `'provider'`.

With Stripe and the defaults, the seller pays Stripe's fees, Stripe covers negative balances, and your platform pays no Connect fees. Lowest risk and least to build. Allowed with Stripe: provider/provider, platform/provider, platform/platform (fees/losses).

### `dashboards.express`

The seller gets Stripe's lighter **Express dashboard** (their details, balance, payouts; payments, refunds, and disputes if you enable them in Stripe's Connect settings).

- `dashboards.express.fees` — must be `'platform'` with Stripe.
- `dashboards.express.losses` — must be `'platform'` with Stripe.

Stripe's Accounts v2 API rejects Express unless your platform pays fees **and** covers losses, so choosing Express means: Stripe bills your platform for processing and Connect fees, and you absorb refunds/disputes a seller can't pay (Stripe may hold a reserve on your balance). Set `platformFee` to cover Stripe's fees. Your app must show sellers their payments and refunds (the capabilities already give you the data).

### `dashboards.none`

No provider dashboard; the seller works only inside your app, which renders the provider's **embedded components** (payments, payouts, disputes, account settings) via `createMerchantSession`.

- `dashboards.none.fees` — default `'provider'`.
- `dashboards.none.losses` — default `'provider'`.

With `losses: 'platform'` and no dashboard, your platform also becomes responsible for collecting the seller's identity requirements (Stripe's onboarding pages can still do the collecting). Most to build.

**Rules enforced at startup (Stripe):** `losses: 'platform'` requires `fees: 'platform'`; Express requires platform/platform. **Warnings:** platform-covered losses (reserves, risk management), platform-paid fees without a `platformFee`. **Info:** sellers on express/none cannot write their own Radar fraud rules and your platform rules don't apply to their direct charges.

### `defaultDashboard`

Dashboard used when several are offered and `startMerchantOnboarding` gets none. Must be one of the offered dashboards (startup error otherwise). Without it and with several dashboards, the seller must choose.

---

## Onboarding

### `onboarding`

### `onboarding.modes`

Where sellers give the provider their identity and bank details. Default `['hosted']`.

| Value | Meaning | What you build |
|---|---|---|
| `'hosted'` | `startMerchantOnboarding` returns a provider-hosted link; the seller comes back to `urls.onboardingReturn` | A button and a return page |
| `'embedded'` | Onboarding runs inside your app with the provider's embedded onboarding component (`createMerchantSession` with `onboarding`) | The component page |

Offer both to let each screen pick (`startMerchantOnboarding({ mode })`).

### `onboarding.collect`

`'currently_due'` (default) collects only what the provider needs now — faster sign-up, more requests later. `'eventually_due'` collects everything up front — longer sign-up, fewer interruptions.

---

## Countries and currencies

### `countries`

### `countries.allowed`

Upper-case ISO 3166-1 codes sellers may register in. Omit to allow any country the provider supports. Useful when your terms, tax setup, or support only cover some countries.

### `countries.default`

Country used when `startMerchantOnboarding` gets none. A country is required to create a provider account; without a default the seller must choose. Must be in `countries.allowed` when both are set.

### `currencies`

Lowercase ISO 4217 codes sellers may charge in. Omit to allow any. The provider still enforces its own minimums (Stripe: e.g. $0.50) and returns them as validation errors with its message.

---

## Charge type

### `chargeType`

How money moves between client, seller, and platform.

| Value | Status | Meaning |
|---|---|---|
| `'direct'` | **Available** (default) | The charge happens on the **seller's** account. The seller's name is on the client's statement; refunds and disputes hit the seller's balance first; your cut is an application fee. |
| `'destination'` | Documented, not available | The charge happens on your platform and is paid on to one seller. Your platform is the merchant of record and liable for refunds/disputes. |
| `'separate'` | Documented, not available | Separate charges and transfers: one payment split across several sellers (marketplace carts). Platform liable. |

Setting a value other than `'direct'` fails at startup in this release.

---

## Your cut (platform fee)

### `platformFee`

Your platform's share of each charge, in the charge currency's minor units. Omit for none. Computed on the server; never taken from the browser.

- Rule: `{ percent?, fixed? }` — both parts add up.
- Function: `({ amount, currency, merchant }) => number | Promise<number>` — per seller, per currency, tiers, promotions. `merchant` has `id`, `ownerType`, `ownerId`, `dashboard`, `feesCollector`.

### `platformFee.percent`

Percentage of the amount, 0–100, rounded half-up to a whole minor unit with exact integer math (5% of 1050 = 53).

### `platformFee.fixed`

Fixed amount per charge, keyed by currency: `{ usd: 30, eur: 25 }`. Currencies without an entry add nothing.

The fee may not exceed the charge amount (validation error). When your platform pays the provider's fees (`fees: 'platform'`), the fee you set must cover them — with Stripe, the whole application fee goes to you and Stripe then bills your platform its processing fee.

---

## Refunds

### `refunds`

### `refunds.refundPlatformFee`

`false` (default, Stripe's default): on a refund, the client gets their money back from the seller's balance and **you keep your cut**. `true`: your platform fee is returned to the seller proportionally, so the seller isn't out of pocket for your fee on refunded sales.

---

## Checkout links

### `checkout`

### `checkout.expiresAfterMinutes`

How long a payment link stays valid: 30–1440 minutes, default 1440 (24 hours, Stripe's maximum). Expired links produce `payments.charge.expired`; create a new charge to retry. Stripe links stay a minute inside Stripe's window (31 minutes to 23 h 59 min), see [stripe.md](./stripe.md#checkout-sessions).

---

## Embedded components

### `embedded`

What sellers may do inside embedded payment components (`createMerchantSession` with `payments` or `disputes`).

### `embedded.allowRefunds`

Default `true`. With `false`, sellers can view payments in the component but must refund through your app's `refundCharge` screen (audited, `access.refunds`). Refunds made in components still appear in `PaymentRefund` through webhooks.

### `embedded.allowDisputeManagement`

Default `true`. Lets sellers respond to disputes (submit evidence) in the component. Disputes still reach your app as `payments.dispute.*` events either way.

---

## Redirect URLs

### `urls`

Absolute URLs, all required.

### `urls.onboardingReturn`

Where the provider sends a seller after onboarding. Call `syncMerchantAccount` there and show the status (the webhook may arrive a moment later).

### `urls.onboardingRefresh`

Where the provider sends a seller whose onboarding link expired or was reused. Call `startMerchantOnboarding` again and redirect. Authenticate the user first — the URL could be shared.

### `urls.checkoutSuccess`

Where the client lands after paying. `{chargeId}` is replaced with the charge id. Show a thank-you page; **do not** deliver here — wait for `payments.charge.paid`.

### `urls.checkoutCancel`

Where the client lands after leaving checkout. `{chargeId}` is replaced too.

---

## Webhooks

### `webhooks`

### `webhooks.path`

Route path of the webhook endpoint. Default `/payments/webhooks/<provider id>` (`/payments/webhooks/stripe`). Must match the URL given to `plumbus payments webhooks setup`.

### `webhooks.bodyLimitBytes`

Maximum webhook body size, 1 KiB–10 MiB, default 1 MiB. Larger bodies get `413`.

### `webhooks.storePayload`

`false` (default): the event ledger keeps only ids, type, and status. `true`: it also keeps each event body — useful for debugging, but bodies contain clients' personal data (emails, names). The ledger's retention is 90 days.

---

## Sharing a provider account between apps

### `appId`

A label stamped into provider metadata (`plumbus_app`) on accounts, customers, and charges. Set it when several apps (or environments) share one provider account, so objects can be traced to the app that made them.

---

## Choices not available in this release

These are real Stripe Connect choices, listed so you can see the whole picture. Asking for them today either fails at startup or has no option yet.

| Choice | Options | Status |
|---|---|---|
| Charge type | destination, separate charges and transfers | Planned (see [`chargeType`](#chargetype)) |
| Payout timing | Stripe default schedule / set by the app / set by the seller | Planned. Today sellers use Stripe's default; full/Express sellers can change it in their dashboard, and your platform can use Stripe's platform controls in the Stripe Dashboard |
| How clients pay | Hosted Checkout page | **Available** (`createCharge`) |
|  | Payment Links, invoices Stripe emails, Checkout embedded in your page, custom card form | Planned |
| Recurring charges | Subscriptions for a seller's clients | Planned |
| Client self-service | Customer portal to update cards or cancel | Planned |
| Linking an existing Stripe account | OAuth "connect with Stripe" | **Not supported**: it needs the older Accounts v1 OAuth flow; this package uses Stripe's newest APIs only. Sellers create a new connected account through onboarding |
| Your app billing its own users | Subscriptions for your SaaS | Planned, separate from Connect |
| Usage-based billing | Stripe meters (e.g. AI usage) | Planned |
| Tax | Stripe Tax on sellers' charges | Planned |
| Previews | Stripe private-preview features (e.g. thin events for v1 resources) | Not used until generally available |

---

## Ready-made setups

**Independent professionals (tutors, coaches, freelancers)** — lowest risk:

```ts
seller: { owner: 'user' },
dashboards: { full: true },
platformFee: { percent: 5 },
```

**Branded experience with a lighter dashboard** — you carry fees and losses:

```ts
seller: { owner: 'user' },
dashboards: { express: true },            // platform pays fees + covers losses
platformFee: { percent: 3, fixed: { usd: 30 } }, // covers Stripe's fees
```

**Let each seller choose** — full by default, Express for those who want it:

```ts
import { percentOf } from '@plumbus/payments'; // exact integer percent, half-up

dashboards: { full: true, express: true },
defaultDashboard: 'full',
platformFee: ({ amount, merchant }) =>
  merchant.feesCollector === 'platform' ? percentOf(amount, 5.9) + 30 : percentOf(amount, 3),
```

**Everything inside your app** — no Stripe dashboard, embedded components:

```ts
dashboards: { none: true },
onboarding: { modes: ['embedded'] },
embedded: { allowRefunds: false }, // refunds only through your audited screen
```

**Organizations (a school or clinic gets paid)**:

```ts
seller: { owner: 'tenant' },
access: { sellers: { roles: ['billing-admin'] }, refunds: { roles: ['finance'] } },
dashboards: { full: true },
```
