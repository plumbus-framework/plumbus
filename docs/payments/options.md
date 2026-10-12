# Payments options — every choice, explained

**Previous:** [getting-started.md](./getting-started.md) · **Next:** [use-cases.md](./use-cases.md)

`@plumbus/payments` does not pick a payments setup for you. Every option below is a
`createPayments()` setting, with what it means for **you** (the platform), the
**seller** (your user or tenant), and the seller's **clients**.

Two kinds of people decide:

- **The app** decides business terms in config: who covers losses, who pays fees, your cut, which dashboards, countries, and features are offered.
- **Each seller** decides, once, among what the app offers: the dashboard (when more than one is offered) and their country. Sellers with a dashboard may also change their payout schedule when you allow it.

> **Permanent per seller:** the dashboard, fees and losses responsibilities, charge type, and country are fixed when the seller's provider account is created. Changing config later affects new sellers only; an existing seller who wants something else needs a new account (their past payments stay on the old one).

A test fails whenever an option is added to the code without a section here. For which features to combine for your kind of app, see [use-cases.md](./use-cases.md).

## Contents

1. [Provider](#provider)
2. [Who the seller is](#who-the-seller-is)
3. [Who may do what](#who-may-do-what)
4. [Dashboards, fees, and losses](#dashboards-fees-and-losses)
5. [Onboarding](#onboarding)
6. [Countries and currencies](#countries-and-currencies)
7. [Charge type](#charge-type)
8. [Transfers to sellers](#transfers-to-sellers)
9. [Your cut (platform fee)](#your-cut-platform-fee)
10. [Refunds](#refunds)
11. [Payment pages](#payment-pages)
12. [Invoices](#invoices)
13. [Subscriptions sellers sell](#subscriptions-sellers-sell)
14. [Payouts](#payouts)
15. [Embedded components](#embedded-components)
16. [Billing your own customers](#billing-your-own-customers)
17. [Redirect URLs](#redirect-urls)
18. [Webhooks](#webhooks)
19. [Sharing a provider account between apps](#sharing-a-provider-account-between-apps)
20. [Choices this release does not offer](#choices-this-release-does-not-offer)
21. [Ready-made setups](#ready-made-setups)

---

## Provider

### `provider`

The payment-provider adapter. Today: `stripeProvider({...})` from `@plumbus/payments-stripe` (see [stripe.md](./stripe.md)). Required. The provider also supplies the defaults used when a dashboard is offered as `true`, adds its own rules (for Stripe, the Accounts v2 combinations below), and must implement every feature you turn on — `createPayments()` fails at startup naming the missing methods otherwise.

---

## Who the seller is

### `seller`

Omit `seller` when only **your platform** takes money (a SaaS billing its customers, see [`billing`](#billing), or platform charges through `payments.platform`). At least one of `seller` and `billing` is required. Options that only make sense with sellers (`dashboards`, `chargeType`, `transfers.enabled`, `subscriptions.enabled`, `payouts`) fail at startup without it.

### `seller.owner`

| Value | Meaning | Good for |
|---|---|---|
| `'user'` | Every signed-in user can connect **their own** provider account. The owner is `ctx.auth.userId`. | Tutors, freelancers, creators — individuals who get paid |
| `'tenant'` | One provider account **per tenant**, shared by everyone `access.sellers` allows. The owner is `ctx.auth.tenantId`. | Schools, clinics, shops — an organization gets paid |

The owner always comes from the caller's auth; no input can act for another seller. Payments entities are tenant-scoped, so a tenant context (`auth.tenantId`) is required in both modes — single-tenant apps set a constant tenant id in their auth. Switching mode later does not migrate existing accounts.

---

## Who may do what

### `access`

Plumbus [`AccessPolicy`](../security/security-model.md) objects for the payments capabilities. Every policy has the same fields — for `access.sellers` they are:

- `access.sellers.roles` — the caller needs at least one of these roles.
- `access.sellers.scopes` — the caller needs all of these scopes.
- `access.sellers.public` — never set this for payments (anonymous callers have no owner).
- `access.sellers.tenantScoped` — require a tenant context (payments requires one anyway).
- `access.sellers.serviceAccounts` — service accounts allowed in addition; do not list `payments-webhook`.

An empty policy (`{}`) lets **any signed-in user** in.

### `access.sellers`

Who may connect an account, open sessions and the dashboard, create, read, capture, and cancel charges, and manage links, subscriptions, clients and their saved methods, payouts, and transfers — always for themselves. Required with `seller`.

### `access.refunds`

Who may refund charges (`refundCharge`). Defaults to `access.sellers`. Narrow it (for example `{ roles: ['finance'] }`) when only some people may give money back. Same fields: `access.refunds.roles`, `access.refunds.scopes`, `access.refunds.public`, `access.refunds.tenantScoped`, `access.refunds.serviceAccounts`.

### `access.disputes`

Who may see and answer disputes (`listDisputes`, `respondToDispute`, `acceptDispute`). Defaults to `access.refunds`. Same fields: `access.disputes.roles`, `access.disputes.scopes`, `access.disputes.public`, `access.disputes.tenantScoped`, `access.disputes.serviceAccounts`.

### `access.billing`

Who may subscribe to, change, and cancel **your platform's plan** and open its billing portal (see [`billing`](#billing)). Required when `billing.customer` is `'tenant'` — decide who may change the tenant's plan, e.g. `{ roles: ['owner', 'billing-admin'] }`. Defaults to any signed-in user of the tenant for `'user'` (each user pays for themselves) and to `access.sellers` for `'seller'`. Same fields: `access.billing.roles`, `access.billing.scopes`, `access.billing.public`, `access.billing.tenantScoped`, `access.billing.serviceAccounts`.

### `access.entitlements`

Who may read the plans, the current plan subscription, and which features it grants (`listPlans`, `getPlanSubscription`, `getEntitlements`). Defaults to any signed-in user of the tenant (`{ tenantScoped: true }`), since every member's screens depend on the plan. Same fields: `access.entitlements.roles`, `access.entitlements.scopes`, `access.entitlements.public`, `access.entitlements.tenantScoped`, `access.entitlements.serviceAccounts`.

---

## Dashboards, fees, and losses

### `dashboards`

Which provider dashboards sellers may get. Offer one or several; when several are offered, each seller picks once at onboarding (pass `dashboard` to `startMerchantOnboarding`, or set `defaultDashboard`). At least one is required with `seller`.

Each offered dashboard is `true` (provider defaults) or `{ fees, losses }`:

- **fees** — who pays the provider's processing fees on the seller's direct charges: `'provider'` (the provider bills the seller directly) or `'platform'` (the provider bills your platform). On destination charges your platform always pays them.
- **losses** — who covers negative balances when a seller cannot pay for refunds or disputes: `'provider'` or `'platform'`.

### `dashboards.full`

The seller gets the provider's **full dashboard** and manages payouts, disputes, reports, and settings there.

- `dashboards.full.fees` — default `'provider'`.
- `dashboards.full.losses` — default `'provider'`.

With Stripe and the defaults, the seller pays Stripe's fees, Stripe covers negative balances, and your platform pays no Connect fees. Lowest risk and least to build. Allowed with Stripe: provider/provider, platform/provider, platform/platform (fees/losses). Default charge type: `direct`.

### `dashboards.express`

The seller gets Stripe's lighter **Express dashboard** (their details, balance, payouts; payments, refunds, and disputes if you enable them in Stripe's Connect settings).

- `dashboards.express.fees` — must be `'platform'` with Stripe.
- `dashboards.express.losses` — must be `'platform'` with Stripe.

Stripe's Accounts v2 API rejects Express unless your platform pays fees **and** covers losses, so choosing Express means: Stripe bills your platform for processing and Connect fees, and you absorb refunds/disputes a seller can't pay (Stripe may hold a reserve on your balance). Set `platformFee` to cover Stripe's fees. Default charge type: `destination` — your platform is the merchant of record, which is what Stripe recommends for Express.

### `dashboards.none`

No provider dashboard; the seller works only inside your app, which renders the provider's **embedded components** (payments, payouts, disputes, account settings) via `createMerchantSession`.

- `dashboards.none.fees` — default `'provider'`.
- `dashboards.none.losses` — default `'provider'`.

With `losses: 'platform'` and no dashboard, your platform also becomes responsible for collecting the seller's identity requirements (Stripe's onboarding pages can still do the collecting). Most to build. Default charge type: `destination`.

**Rules enforced at startup (Stripe):** `losses: 'platform'` requires `fees: 'platform'`; Express requires platform/platform. **Warnings:** platform-covered losses (reserves, risk management); your platform pays processing fees (platform fees or destination charges) without a `platformFee`; destination charges without platform liability on full or Express (Stripe recommends platform/platform); direct charges on Express or no dashboard (Stripe recommends destination charges). **Info:** sellers on express/none cannot write their own Radar fraud rules and your platform rules don't apply to their direct charges; destination charges for full-dashboard sellers.

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

How a seller's charges move money. One value for every dashboard (`chargeType: 'destination'`), or one per dashboard (below). A seller keeps the charge type they onboarded with.

| Value | Where the charge lives | Merchant of record | Refunds and disputes | Your cut |
|---|---|---|---|---|
| `'direct'` | The **seller's** account | The seller: their name on the client's statement | Hit the seller's balance first | An application fee taken from the charge |
| `'destination'` | **Your platform's** account, paid on to one seller at once | Your platform (or the seller's name, with [`destination.onBehalfOf`](#destinationonbehalfof)) | Your platform's balance; by default the refund takes the seller's share back ([`refunds.reverseTransfer`](#refundsreversetransfer)) | An application fee your platform keeps; the rest goes to the seller |

The seller's provider account asks for what its charge type needs: card payments for direct charges, receiving transfers for destination charges. For one payment split across several sellers (a marketplace cart), use platform charges and [transfers](#transfers-to-sellers).

### `chargeType.full`

Charge type of full-dashboard sellers. Default `'direct'`: they run their own Stripe account.

### `chargeType.express`

Charge type of Express sellers. Default `'destination'`.

### `chargeType.none`

Charge type of sellers without a dashboard. Default `'destination'`.

### `destination`

### `destination.onBehalfOf`

Default `false`. `true` puts the **seller's** name and country on the client's statement for destination charges (Stripe's `on_behalf_of`): the seller becomes the settlement merchant and also needs card payments enabled; your platform still pays Stripe's fees and handles refunds and disputes. Use it when clients should recognise the seller rather than your platform on their bank statement.

---

## Transfers to sellers

### `transfers`

### `transfers.enabled`

Default `false`. `true` lets your server pay sellers from platform charges: every new seller also asks for the ability to receive transfers, `payments.platform.transferToSeller(ctx, { merchantAccountId, amount, currency, chargeId })` sends them money, and sellers see what they received with `listTransfers`. This is how you split one payment across several sellers (separate charges and transfers): charge the client on the platform with `payments.platform.createCharge`, then transfer each seller's share once the charge is paid. A transfer tied to a charge (`chargeId`) waits for that charge's funds and cannot exceed it. Your platform is the merchant of record and covers refunds and disputes. Stripe limits transfers across regions; see Stripe's cross-border rules before you sell internationally.

---

## Your cut (platform fee)

### `platformFee`

Your platform's share of each charge, in the charge currency's minor units. Omit for none. Computed on the server; never taken from the browser.

- Rule: `{ percent?, fixed? }` — both parts add up.
- Function: `({ amount, currency, kind, flow, merchant }) => number | Promise<number>` — per seller, per currency, per way of paying, tiers, promotions. `kind` is how the client pays (`'checkout'`, `'invoice'`, `'saved_method'`, `'link'`) or `'capture'` (a held charge being captured, when the fee is recomputed on the captured amount); `flow` is `'direct'` or `'destination'`; `merchant` has `id`, `ownerType`, `ownerId`, `dashboard`, `feesCollector`.

The fee is fixed when a charge is created (for items, on their total; for an amount the client chooses, on its minimum or preset). A held charge's fee is recomputed on the captured amount. A payment link's fee is fixed at creation: Stripe links cannot scale a fee with the quantity or amount the client picks.

### `platformFee.percent`

Percentage of the amount, 0–100, rounded half-up to a whole minor unit with exact integer math (5% of 1050 = 53).

### `platformFee.fixed`

Fixed amount per charge, keyed by currency: `{ usd: 30, eur: 25 }`. Currencies without an entry add nothing.

The fee may not exceed the charge amount (validation error). When your platform pays the provider's fees (`fees: 'platform'` or destination charges), the fee you set must cover them — with Stripe, the whole application fee goes to you and Stripe then bills your platform its processing fee.

---

## Refunds

### `refunds`

### `refunds.refundPlatformFee`

`false` (default, Stripe's default): on a refund you **keep your cut**. `true`: your platform fee is returned proportionally, so the seller isn't out of pocket for your fee on refunded sales.

### `refunds.reverseTransfer`

Destination charges only. `true` (default): a refund takes the seller's share back from their balance, proportionally — the seller bears the refund, like on a direct charge. `false`: your platform funds the whole refund and the seller keeps what they received.

---

## Payment pages

### `checkout`

Settings of the payment pages clients pay on. Each charge can override them with its own `options` (`createCharge({ options: { locale: 'fr' } })`).

### `checkout.expiresAfterMinutes`

How long a payment page stays valid: 30–1440 minutes, default 1440 (24 hours, Stripe's maximum). Expired pages produce `payments.charge.expired`; create a new charge to retry. Stripe pages stay a minute inside Stripe's window (31 minutes to 23 h 59 min), see [stripe.md](./stripe.md#checkout-sessions).

### `checkout.ui`

`'hosted'` (default): `createCharge` returns a `url` to a provider-hosted page; clients land on `urls.checkoutSuccess` or `urls.checkoutCancel`. `'embedded'`: the page is embedded in your own page — `createCharge` returns `url: null` and `checkout: { clientSecret, publishableKey, accountId }` for the provider's embedded checkout (with Stripe, `stripe.initEmbeddedCheckout({ fetchClientSecret })`, with `Stripe(publishableKey, { stripeAccount: accountId })` when `accountId` is set — the seller's account for direct charges); clients land on `urls.checkoutReturn`. Needs the provider's publishable key. A charge can ask for either with `ui`.

### `checkout.locale`

Language of the payment page, e.g. `'fr'`, `'de'`, `'auto'` (the browser's language). Default: the provider's (Stripe: `auto`).

### `checkout.allowPromotionCodes`

Default `false`. `true` shows a promotion-code field; codes are created in the provider's dashboard (for direct charges, the seller's). The charge records `amountDiscount`; the fee stays what it was computed on.

### `checkout.automaticTax`

Default `false`. `true` calculates tax with the provider's tax engine (Stripe Tax). The account the charge lives on needs tax registrations set up — for direct charges that is the seller's account. The charge records `amountTax`; `amountTotal` is what the client paid.

### `checkout.billingAddress`

`'auto'` (the provider asks when needed) or `'required'` (always). Default: the provider's (`auto`).

### `checkout.phone`

Default `false`. `true` asks for the client's phone number.

### `checkout.shippingCountries`

Upper-case country codes to ship to; the page then collects a shipping address. Omit for none.

### `checkout.submitType`

Label of the pay button: `'auto'`, `'pay'`, `'book'`, or `'donate'`.

**Per charge, besides these:** `items` (line items, each `{ name, description?, unitAmount, quantity? }`, instead of one `amount`), `customAmount` (the client chooses the amount: `{ minimum?, maximum?, preset? }`), `capture: 'manual'` (hold the amount; `captureCharge` takes all or part within the provider's hold period, `cancelCharge` releases it), `saveMethod` (keep the card for `chargeSavedMethod`), `statementDescriptorSuffix`, and `collection: 'invoice'` ([invoices](#invoices)).

---

## Invoices

### `invoices`

`createCharge({ collection: 'invoice', client: { email } })` sends the client an invoice by email instead of a payment page; the charge's `url` is the invoice's own payment page. The charge is paid when the invoice is; `cancelCharge` voids an unpaid one.

### `invoices.daysUntilDue`

Days the client has to pay, 1–365, default 30. A charge can set its own `dueInDays`.

---

## Subscriptions sellers sell

### `subscriptions`

### `subscriptions.enabled`

Default `false`. `true` lets sellers sell recurring plans to their clients: `createSubscription` opens a subscription page (items with `interval` month/year/week/day, optional `trialDays`); the subscription starts when the client pays, and `payments.subscription.started/updated/ended` and `payments.invoice.paid/paymentFailed` follow the renewals. Sellers can `cancelSubscription` (at the period end by default), `resumeSubscription`, and send clients to the provider's client portal (`createClientPortalSession`) to update their card or cancel. The subscription lives where the seller's charges do (their account for direct charges, your platform for destination charges).

### `subscriptions.platformFeePercent`

Your cut of each subscription payment as a percentage (at most two decimals), or a function `({ currency, flow, merchant }) => number`. Providers take subscription fees only as a percentage. Default: `platformFee.percent` when `platformFee` is a rule without a fixed part; otherwise 0, with a startup warning.

---

## Payouts

When and how sellers receive their money. By default the provider's schedule applies (Stripe: daily, after a delay that depends on the country), and full-dashboard sellers manage their own in their dashboard. Every payout reaches your app as a `PaymentPayout` row, with `payments.payout.paid` and `payments.payout.failed` events; sellers read theirs with `listPayouts` and `getPayoutSettings`.

### `payouts`

### `payouts.schedule`

The schedule set for each **new** seller on Express or no dashboard (whose losses your platform covers; the provider does not let platforms set it for full-dashboard sellers). Fields:

- `payouts.schedule.interval` — `'manual'` (only when requested), `'daily'`, `'weekly'`, or `'monthly'`.
- `payouts.schedule.delayDays` — days funds wait before they can be paid out, 0–31, or `'minimum'` (the shortest the seller's country allows).
- `payouts.schedule.weeklyAnchor` — weekly payouts: `'monday'` to `'friday'` (payouts are not sent on weekends).
- `payouts.schedule.monthlyAnchor` — monthly payouts: the day of the month, 1–31 (the last day in shorter months).

Longer delays keep a buffer for refunds and disputes you cover.

### `payouts.sellersMayChangeSchedule`

Default `false`. `true` adds `updatePayoutSchedule`, which lets Express and no-dashboard sellers change their own schedule (full-dashboard sellers use their dashboard).

### `payouts.instant`

Default `false`. `true` adds `createInstantPayout`: sellers take available funds within minutes to an eligible debit card, for the provider's instant-payout fee. `getPayoutSettings` says whether a seller can.

---

## Embedded components

### `embedded`

What sellers may do inside embedded payment components (`createMerchantSession` with `payments` or `disputes`).

### `embedded.allowRefunds`

Default `true`. With `false`, sellers can view payments in the component but must refund through your app's `refundCharge` screen (audited, `access.refunds`). Refunds made in components still appear in `PaymentRefund` through webhooks.

### `embedded.allowDisputeManagement`

Default `true`. Lets sellers respond to disputes (submit evidence) in the component. Disputes still reach your app as `payments.dispute.*` events either way, and your app can answer them with `respondToDispute`.

---

## Billing your own customers

### `billing`

Your platform charging **its own** customers for plans — a SaaS subscription — separate from sellers' charges (a seller's clients never see your plans). The catalog (products, prices, features, usage meters) is derived from this config and created at the provider with `plumbus payments catalog sync`; prices are found by lookup key (`plumbus:<appId>:<plan>:<price>`), so a price change in config makes a new provider price while existing subscribers keep theirs. See [billing.md](./billing.md).

Capabilities: `listPlans`, `subscribeToPlan` (a checkout page), `getPlanSubscription`, `changePlan`, `cancelPlanSubscription`, `resumePlanSubscription`, `openBillingPortal`, `getEntitlements`. Server-side: `payments.billing.hasFeature(ctx, feature)` to gate your own capabilities, `setSeats`, `recordUsage`, `purchase` (a one-off purchase), and `aiUsageBridge` (meters every AI call).

### `billing.customer`

Who pays: `'tenant'` (the organization; `access.billing` decides who may change its plan), `'user'` (each user for themselves), or `'seller'` (your sellers pay you a subscription, e.g. for premium tools; needs `seller`). Required.

### `billing.plans`

Plans by key (letters, digits, `_`, `-`; the key is part of the lookup key, so renaming a plan makes a new one). Optional (payments 0.2.1+): omit it when your platform only sells one-off purchases through `payments.billing.purchase` — a fixed product per order, with no subscription; `listPlans` then returns none and `catalog sync` has nothing to create. Each plan:

- `billing.plans.<key>.name` — shown at checkout and on invoices.
- `billing.plans.<key>.description` — shown at checkout.
- `billing.plans.<key>.features` — entitlement feature keys the plan grants, e.g. `['ai', 'export']`. Entitlements arrive by webhook and are stored per customer; read them with `getEntitlements` or `payments.billing.hasFeature`.
- `billing.plans.<key>.prices` — prices by key, e.g. `monthly` and `yearly`. Each price:
  - `billing.plans.<key>.prices.<key>.amount` — minor units per period (per seat when per-seat).
  - `billing.plans.<key>.prices.<key>.currency` — lowercase ISO code.
  - `billing.plans.<key>.prices.<key>.interval` — `'day'`, `'week'`, `'month'`, or `'year'`.
  - `billing.plans.<key>.prices.<key>.intervalCount` — periods between payments, 1–36 (3 with `month` = quarterly). Default 1.
  - `billing.plans.<key>.prices.<key>.perSeat` — charge per seat; `subscribeToPlan({ quantity })` and `payments.billing.setSeats(ctx, { quantity })` set the count (e.g. the tenant's member count).
- `billing.plans.<key>.meters` — usage meters billed on this plan, from `billing.meters`; the plan needs a price in each meter's currency.
- `billing.plans.<key>.trialDays` — free days before the first payment, 1–730.

### `billing.meters`

Usage meters by key, billed per unit at the end of each period:

- `billing.meters.<key>.name` — shown on invoices.
- `billing.meters.<key>.eventName` — the provider's event name (lowercase letters, digits, `_`).
- `billing.meters.<key>.aggregation` — how a period's usage adds up: `'sum'` (default), `'count'`, or `'last'`. Stripe cannot change a meter's aggregation later; use a new `eventName` instead.
- `billing.meters.<key>.unitAmount` — minor units per unit of usage; a decimal string allows fractions (`'0.002'` = 0.002 cents per token).
- `billing.meters.<key>.currency` — lowercase ISO code.
- `billing.meters.<key>.interval` — billing period of the usage price, default `'month'`.

Record usage with `payments.billing.recordUsage(ctx, { meter, value, identifier })` — the provider counts one event per `identifier`, so retries are safe — or wire `payments.billing.aiUsageBridge({ meter, value: 'tokens' | 'costMicros' })` as your `onAICostRecorded` hook.

### `billing.features`

Display names of feature keys: `{ ai: { name: 'AI assistant' } }`. Keys without an entry show as themselves. Each key becomes a provider entitlement feature.

- `billing.features.<key>.name` — shown in the provider's dashboard and your pricing page (`listPlans`).

### `billing.trialDays`

Free days before the first payment, for every plan without its own `trialDays`. Omit for none.

### `billing.allowPromotionCodes`

Default `false`. `true` shows a promotion-code field on plan checkout pages.

### `billing.automaticTax`

Default `false`. `true` calculates tax on plans with the provider's tax engine (your platform's tax registrations).

### `billing.prorate`

Default `true`: plan and seat changes are prorated (credit for the unused part, a charge for the rest). `false`: changes take effect on the next invoice.

---

## Redirect URLs

### `urls`

Absolute URLs. Each is needed by the features that redirect there; `createPayments()` fails at startup when a turned-on feature misses one, and a capability that needs a missing one fails with `payments_url_missing`.

### `urls.onboardingReturn`

Required with `seller`. Where the provider sends a seller after onboarding. Call `syncMerchantAccount` there and show the status (the webhook may arrive a moment later).

### `urls.onboardingRefresh`

Required with `seller`. Where the provider sends a seller whose onboarding link expired or was reused. Call `startMerchantOnboarding` again and redirect. Authenticate the user first — the URL could be shared.

### `urls.checkoutSuccess`

Hosted payment pages (required with `checkout.ui: 'hosted'`): where the client lands after paying. `{chargeId}` is replaced with the charge id (`{subscriptionId}` for subscription pages). Show a thank-you page; **do not** deliver here — wait for `payments.charge.paid`.

### `urls.checkoutCancel`

Hosted payment pages: where the client lands after leaving. `{chargeId}` is replaced too.

### `urls.checkoutReturn`

Embedded payment pages (required with `checkout.ui: 'embedded'`): where the client lands after paying. `{chargeId}` (or `{subscriptionId}`) is replaced.

### `urls.setupSuccess`

Where the client lands after saving a payment method (`saveClientPaymentMethod`). `{clientId}` is replaced.

### `urls.setupCancel`

Where the client lands if they leave saving a payment method. `{clientId}` is replaced.

### `urls.portalReturn`

Where the client portal (`createClientPortalSession`) sends the client back to.

### `urls.billingSuccess`

Required with `billing.plans`. Where a customer lands after subscribing to a plan. `{subscriptionId}` is replaced.

### `urls.billingCancel`

Required with `billing.plans`. Where a customer lands if they leave plan checkout.

### `urls.billingPortalReturn`

Where the billing portal (`openBillingPortal`) sends the customer back to.

### `urls.linkCompleted`

Where a client lands after paying through a payment link. Omit to show the provider's confirmation page.

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

A label stamped into provider metadata (`plumbus_app`) on accounts, customers, and charges, and the namespace of the billing catalog's lookup keys (`plumbus:<appId>:…`; `app` when unset). Set it when several apps (or environments) share one provider account, so objects can be traced to the app that made them and their plans never collide.

---

## Choices this release does not offer

| Choice | Status |
|---|---|
| Linking an existing Stripe account (OAuth "connect with Stripe") | **Not supported**: it needs the older Accounts v1 OAuth flow; this package uses Stripe's newest APIs only. Sellers create a new connected account through onboarding |
| A custom card form in your page (Stripe Elements with a PaymentIntent) | Not offered; use embedded payment pages (`checkout.ui: 'embedded'`), which keep card data off your servers |
| Seller-defined products and price lists at the provider | Not offered; charges and seller subscriptions take their prices inline, and your platform's own plans come from `billing` |
| Stripe private previews (e.g. thin events for v1 resources) | Not used until generally available |

---

## Ready-made setups

More complete recipes, by kind of app, are in [use-cases.md](./use-cases.md).

**Independent professionals (tutors, coaches, freelancers)** — lowest risk:

```ts
seller: { owner: 'user' },
dashboards: { full: true },
platformFee: { percent: 5 },
```

**Branded marketplace with a lighter dashboard** — destination charges, you carry fees and losses:

```ts
seller: { owner: 'user' },
dashboards: { express: true },                   // destination charges by default
platformFee: { percent: 3, fixed: { usd: 30 } }, // covers Stripe's fees
payouts: { schedule: { interval: 'weekly', weeklyAnchor: 'friday', delayDays: 7 } },
```

**Let each seller choose** — full by default, Express for those who want it:

```ts
import { percentOf } from '@plumbus/payments'; // exact integer percent, half-up

dashboards: { full: true, express: true },
defaultDashboard: 'full',
platformFee: ({ amount, merchant }) =>
  merchant.feesCollector === 'platform' ? percentOf(amount, 5.9) + 30 : percentOf(amount, 3),
```

**Everything inside your app** — no Stripe dashboard, embedded components and pages:

```ts
dashboards: { none: true },
onboarding: { modes: ['embedded'] },
checkout: { ui: 'embedded' },
embedded: { allowRefunds: false }, // refunds only through your audited screen
```

**Organizations (a school or clinic gets paid)**:

```ts
seller: { owner: 'tenant' },
access: { sellers: { roles: ['billing-admin'] }, refunds: { roles: ['finance'] } },
dashboards: { full: true },
invoices: { daysUntilDue: 14 },
subscriptions: { enabled: true },
```

**A SaaS billing its tenants** — no sellers:

```ts
access: { billing: { roles: ['owner'] } },
billing: {
  customer: 'tenant',
  plans: {
    team: { name: 'Team', features: ['ai'], prices: { monthly: { amount: 1500, currency: 'usd', interval: 'month', perSeat: true } }, meters: ['aiTokens'] },
  },
  meters: { aiTokens: { name: 'AI tokens', eventName: 'ai_tokens', unitAmount: '0.002', currency: 'usd' } },
},
urls: { billingSuccess: 'https://app.example/billing/done', billingCancel: 'https://app.example/billing' },
```
