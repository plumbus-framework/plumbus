# Choosing @plumbus/payments options

Every option is explained in full (with provider rules, costs, and what the app must build) in [docs/payments/options.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/payments/options.md). This file is the short decision guide. **Ask the user** for the business choices marked ★ — they decide who carries risk and cost; do not pick them silently.

## Required

| Option | Values | Notes |
|---|---|---|
| `provider` | `stripeProvider({...})` | See payments-stripe instructions |
| `seller.owner` ★ | `'user'` \| `'tenant'` | `user`: every signed-in user can connect their own account. `tenant`: one account per tenant, shared by everyone allowed by `access.sellers` |
| `access.sellers` | Plumbus `AccessPolicy` | Who may connect, charge, and list. `{}` = any signed-in user |
| `dashboards` ★ | `{ full?, express?, none? }` | Which provider dashboards sellers may pick. `true` = provider defaults for responsibilities |
| `urls.*` | absolute URLs | `onboardingReturn`, `onboardingRefresh`, `checkoutSuccess`, `checkoutCancel` (`{chargeId}` placeholder allowed in checkout URLs) |

## Dashboards and responsibilities (★)

Each offered dashboard carries `fees` (who pays the provider's processing fees) and `losses` (who covers refunds/disputes a seller can't pay): `'provider'` or `'platform'`.

With Stripe (Accounts v2):

| Dashboard | Default (fees / losses) | Allowed (fees / losses) |
|---|---|---|
| `full` | provider / provider | provider / provider · platform / provider · platform / platform |
| `express` | platform / platform | **only** platform / platform (Stripe rule) |
| `none` | provider / provider | same as `full`; platform losses + no dashboard makes you responsible for seller identity requirements |

Always: `losses: 'platform'` requires `fees: 'platform'`. Offering several dashboards lets each seller choose once; set `defaultDashboard` or pass `dashboard` to `startMerchantOnboarding`.

## Optional

| Option | Default | Use |
|---|---|---|
| `defaultDashboard` | none | Dashboard when the seller doesn't choose |
| `onboarding.modes` | `['hosted']` | Add `'embedded'` to onboard inside your app via `createMerchantSession` |
| `onboarding.collect` | `'currently_due'` | `'eventually_due'` collects everything up front |
| `countries.allowed` / `countries.default` | any / none | Seller countries (upper-case ISO-3166). A country is required to create an account |
| `chargeType` | `'direct'` | Only `direct` ships in this release |
| `currencies` | any | Lowercase ISO codes sellers may charge in |
| `platformFee` ★ | none | `{ percent, fixed: { usd: 30 } }` or a function `({ amount, currency, merchant }) => minorUnits` for per-seller pricing |
| `refunds.refundPlatformFee` ★ | `false` | Return your fee to the seller on refunds |
| `checkout.expiresAfterMinutes` | `1440` | Payment link lifetime, 30–1440 |
| `embedded.allowRefunds` / `allowDisputeManagement` | `true` / `true` | What sellers can do inside embedded payment components |
| `webhooks.path` | `/payments/webhooks/<provider>` | Route path |
| `webhooks.bodyLimitBytes` | 1 MiB | Webhook body limit |
| `webhooks.storePayload` | `false` | Keep raw event bodies (personal data) |
| `appId` | none | Tag provider objects when several apps share one provider account |

## Rules agents get wrong

- If sellers pay nothing to the platform but the platform pays fees (`fees: 'platform'` with no `platformFee`), you lose money on every charge — startup warns.
- `countries.default` must be in `countries.allowed`; `defaultDashboard` must be offered — both throw.
- Destination and separate charges are documented but not available; `chargeType` other than `direct` throws.
- Changing `dashboards` later does not change existing sellers — their dashboard and responsibilities are fixed at creation.
