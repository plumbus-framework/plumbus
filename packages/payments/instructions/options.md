# Choosing @plumbus/payments options

Every option is explained in full (with provider rules, costs, and what the app must build) in [docs/payments/options.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/payments/options.md), and whole setups by kind of app in [docs/payments/use-cases.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/payments/use-cases.md). This file is the short decision guide. **Ask the user** for the business choices marked ★ — they decide who carries risk and cost; do not pick them silently.

## Pick the shape first

| The app… | Configure |
|---|---|
| Lets its users (or tenants) charge **their own clients** | `seller` (+ `access.sellers`, `dashboards`, onboarding and checkout `urls`) |
| Bills **its own customers** for plans (SaaS) | `billing` (+ `access.billing`, `urls.billingSuccess`, `urls.billingCancel`) |
| Both | Both — they are independent |

At least one of `seller` and `billing` is required.

## Sellers

| Option | Values | Notes |
|---|---|---|
| `provider` | `stripeProvider({...})` | See payments-stripe instructions |
| `seller.owner` ★ | `'user'` \| `'tenant'` | `user`: every signed-in user can connect their own account. `tenant`: one account per tenant, shared by everyone allowed by `access.sellers` |
| `access.sellers` | Plumbus `AccessPolicy` | Who may connect, charge, and manage their payments. `{}` = any signed-in user. Also `access.refunds`, `access.disputes` (default: the one before) |
| `dashboards` ★ | `{ full?, express?, none? }` | Which provider dashboards sellers may pick. `true` = provider defaults for responsibilities |
| `chargeType` ★ | `'direct'` \| `'destination'`, or per dashboard | Default: full → `direct`, express/none → `destination` (Stripe's recommendation) |
| `urls.*` | absolute URLs | Always `onboardingReturn`, `onboardingRefresh`; hosted pages `checkoutSuccess`, `checkoutCancel` (`{chargeId}`); embedded pages `checkoutReturn` |

### Dashboards and responsibilities (★)

Each offered dashboard carries `fees` (who pays the provider's processing fees on direct charges) and `losses` (who covers refunds/disputes a seller can't pay): `'provider'` or `'platform'`.

With Stripe (Accounts v2):

| Dashboard | Default (fees / losses) | Allowed (fees / losses) | Default charge type |
|---|---|---|---|
| `full` | provider / provider | provider / provider · platform / provider · platform / platform | `direct` |
| `express` | platform / platform | **only** platform / platform (Stripe rule) | `destination` |
| `none` | provider / provider | same as `full`; platform losses + no dashboard makes you responsible for seller identity requirements | `destination` |

Always: `losses: 'platform'` requires `fees: 'platform'`. Offering several dashboards lets each seller choose once; set `defaultDashboard` or pass `dashboard` to `startMerchantOnboarding`.

### Charge type (★)

- `direct`: the charge lives on the seller's account; the seller is the merchant of record; your cut is an application fee.
- `destination`: the charge lives on your platform and is paid on to the seller; your platform is the merchant of record, pays the Stripe fees, and handles disputes. `destination.onBehalfOf: true` puts the seller's name on the statement. `refunds.reverseTransfer` (default `true`) takes a refund back from the seller's share.
- One payment split across several sellers: `transfers.enabled: true`, then `payments.platform.createCharge` + `payments.platform.transferToSeller` from your own capability.

## Optional seller features

| Option | Default | Use |
|---|---|---|
| `defaultDashboard` | none | Dashboard when the seller doesn't choose |
| `onboarding.modes` | `['hosted']` | Add `'embedded'` to onboard inside your app via `createMerchantSession` |
| `onboarding.collect` | `'currently_due'` | `'eventually_due'` collects everything up front |
| `countries.allowed` / `countries.default` | any / none | Seller countries (upper-case ISO-3166). A country is required to create an account |
| `currencies` | any | Lowercase ISO codes sellers may charge in |
| `platformFee` ★ | none | `{ percent, fixed: { usd: 30 } }` or a function `({ amount, currency, kind, flow, merchant }) => minorUnits` |
| `refunds.refundPlatformFee` ★ | `false` | Return your fee on refunds |
| `refunds.reverseTransfer` ★ | `true` | Destination charges: take refunds back from the seller's share |
| `destination.onBehalfOf` | `false` | Destination charges show the seller's name and country |
| `transfers.enabled` | `false` | Pay sellers from platform charges (`payments.platform.transferToSeller`) |
| `checkout.expiresAfterMinutes` | `1440` | Payment page lifetime, 30–1440 |
| `checkout.ui` | `'hosted'` | `'embedded'`: `createCharge` returns `checkout.clientSecret` instead of `url` |
| `checkout.locale` / `allowPromotionCodes` / `automaticTax` / `billingAddress` / `phone` / `shippingCountries` / `submitType` | provider defaults | Page settings; each charge can override them with `options` |
| `invoices.daysUntilDue` | `30` | `createCharge({ collection: 'invoice' })` emails an invoice |
| `subscriptions.enabled` / `platformFeePercent` ★ | `false` / from `platformFee.percent` | Sellers sell recurring plans to their clients |
| `payouts.schedule` ★ | provider's | Schedule set for new Express/no-dashboard sellers (`interval`, `delayDays`, `weeklyAnchor` Mon–Fri, `monthlyAnchor`) |
| `payouts.sellersMayChangeSchedule` / `payouts.instant` | `false` / `false` | Adds `updatePayoutSchedule` / `createInstantPayout` |
| `embedded.allowRefunds` / `allowDisputeManagement` | `true` / `true` | What sellers can do inside embedded payment components |

## Billing your own customers

| Option | Notes |
|---|---|
| `billing.customer` ★ | `'tenant'` (requires `access.billing`: who may change the tenant's plan), `'user'`, or `'seller'` |
| `billing.plans` ★ | `{ key: { name, features?, prices: { monthly: { amount, currency, interval, perSeat? } }, meters?, trialDays? } }` |
| `billing.meters` | `{ key: { name, eventName, unitAmount ('0.002' allowed), currency, aggregation?, interval? } }` for usage billing (AI tokens) |
| `billing.features` | Display names of feature keys |
| `billing.trialDays` / `allowPromotionCodes` / `automaticTax` / `prorate` | Plan checkout and change settings (`prorate` default `true`) |
| `access.entitlements` | Who may read plans and features; default any signed-in tenant user |

After changing `billing`, run `plumbus payments catalog sync` (creates products, prices, features, meters at the provider; safe to repeat). `plumbus payments catalog check` fails when they differ — put it in CI.

## Always available

| Option | Default | Use |
|---|---|---|
| `webhooks.path` | `/payments/webhooks/<provider>` | Route path |
| `webhooks.bodyLimitBytes` | 1 MiB | Webhook body limit |
| `webhooks.storePayload` | `false` | Keep raw event bodies (personal data) |
| `appId` | `app` in lookup keys | Tag provider objects and namespace the catalog when several apps share one provider account |

## Rules agents get wrong

- If the platform pays processing fees (`fees: 'platform'`, or destination charges) and there is no `platformFee`, you lose money on every charge — startup warns.
- `countries.default` must be in `countries.allowed`; `defaultDashboard` must be offered — both throw.
- A feature needs its URLs: embedded pages need `urls.checkoutReturn`, `saveClientPaymentMethod` needs `urls.setupSuccess`/`setupCancel`, the client portal `urls.portalReturn`, billing `urls.billingSuccess`/`billingCancel`, the billing portal `urls.billingPortalReturn`.
- Changing `dashboards` or `chargeType` later does not change existing sellers — their dashboard, responsibilities, and charge type are fixed at creation.
- A price change in `billing` makes a new provider price at the next `catalog sync`; existing subscribers keep the old price until `changePlan`.
- Weekly payouts go out Monday to Friday only; `delayDays` is at most 31.
