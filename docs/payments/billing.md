# Billing your own customers

**Previous:** [use-cases.md](./use-cases.md) · **Next:** [stripe.md](./stripe.md)

`billing` in `createPayments()` is your app charging **its own** customers — organizations, users, or your sellers — for plans. It is independent of sellers' charges: a seller's clients never see your plans, and an app can have billing without any sellers. Options: [options.md § billing](./options.md#billing).

## The catalog

Plans, prices, features, and meters are declared in config and created at the provider by the CLI:

```bash
plumbus payments catalog sync    # create or update; prints price ids; safe on every deploy
plumbus payments catalog check   # read-only; exit 1 when the provider differs (CI)
```

| Config | At Stripe |
|---|---|
| A plan | A product (id derived from the plan key and `appId`) |
| A plan price | A price with lookup key `plumbus:<appId>:<plan>:<price>` |
| A feature key | An entitlement feature with lookup key `plumbus:<appId>:feature:<key>`, attached to the products of the plans that list it |
| A meter | A billing meter (by `eventName`), a product, and a metered price with lookup key `plumbus:<appId>:meter:<meter>` |

Changing a price's amount, currency, or interval makes a **new** price that takes over the lookup key; the old one is archived. Existing subscribers keep paying the old price until they change plan (`changePlan` moves them to the current one). Renaming a plan key makes a new plan. A meter's aggregation cannot change at Stripe — `catalog sync` refuses and says so; use a new `eventName`.

`plumbus payments doctor --live` also reports an out-of-date catalog.

## Who pays

| `billing.customer` | Billing customer | Who may change the plan |
|---|---|---|
| `'tenant'` | The tenant (`auth.tenantId`) | `access.billing` (required) |
| `'user'` | Each user (`auth.userId`) | Default: the user, for themselves |
| `'seller'` | Each connected seller (your sellers pay you, e.g. for premium tools) | Default: `access.sellers` |

A billing customer is created at the provider the first time it subscribes or buys (`PaymentBillingCustomer`), with the tenant in its metadata so webhooks find it. One is kept per test and live mode. If the provider no longer has the saved customer (the app moved to another provider account in the same mode, or a test account was reset), the next purchase or plan checkout makes a new one for the same row and tries once more; the provider reports this with `reason: 'payments_provider_customer_missing'`.

## The subscription lifecycle

1. **Pricing page:** `listPlans` → plans with names, descriptions, features, and prices.
2. **Subscribe:** `subscribeToPlan({ plan, price, quantity?, email? })` → `subscription.checkoutUrl` (a provider checkout page; `ui: 'embedded'` for an embedded one). The subscription is `incomplete` until the customer pays; `payments.subscription.started` follows. A customer with a live plan must use `changePlan` instead.
3. **Entitlements:** when the plan starts or changes, the provider sends the customer's active features; they are stored in `PaymentEntitlement` and announced with `payments.entitlements.updated` (`added`, `removed`). Gate your capabilities with `payments.billing.hasFeature(ctx, 'ai')` — not with the plan name, so plans can be regrouped without code changes. Browsers read `getEntitlements`.
4. **Renewals:** `payments.invoice.paid` each period; a failed payment gives `payments.invoice.paymentFailed` and the subscription becomes `past_due` (`payments.subscription.updated`) while the provider retries.
5. **Changes:** `changePlan({ plan, price, quantity? })`, prorated unless `billing.prorate: false`. Seats: `payments.billing.setSeats(ctx, { quantity })` from your own code, e.g. when a member joins.
6. **Self-service:** `openBillingPortal` → the provider's portal (payment method, invoices, cancel).
7. **Cancel:** `cancelPlanSubscription()` at the period end (or `{ atPeriodEnd: false }` now); `resumePlanSubscription` undoes a pending cancel. `payments.subscription.ended` when it ends.

`getPlanSubscription` returns the current subscription, its invoices, and features in one call for a billing settings page.

## Usage meters

A plan can bill usage per unit at the end of each period, on the same invoice:

```ts
meters: { aiTokens: { name: 'AI tokens', eventName: 'ai_tokens', unitAmount: '0.002', currency: 'usd' } },
plans: { pro: { …, meters: ['aiTokens'] } },
```

Record usage from your code:

```ts
await payments.billing.recordUsage(ctx, { meter: 'aiTokens', value: 1200, identifier: `ai-session:${sessionId}` });
```

The provider counts one event per `identifier`, so retries of the same unit of work are safe. Usage for a customer without a billing account (no plan yet) is refused with `payments_no_billing_customer`. Declare `...payments.effects.billing` in the capability's `effects`.

### The AI usage bridge

Plumbus records the tokens and cost of every AI call. `aiUsageBridge` turns that into metered usage without touching your AI code:

```ts
// app/server.ts
import { payments } from './payments/index.js';

export const onAICostRecorded = payments.billing.aiUsageBridge({
  meter: 'aiTokens',
  value: 'tokens',           // or 'costMicros' (cost in millionths of a dollar), or (record) => number
});
```

It meters each call onto the tenant's (or, with `billing.customer: 'user'`, the acting user's) billing customer, with the AI record id as the identifier. Calls without a billing customer are skipped, and a failure never reaches the AI call. It is not for `billing.customer: 'seller'`.

## One-off purchases

`payments.billing.purchase(ctx, { amount | items, currency, description, email?, metadata?, requestId? })` bills the caller's billing customer once (credits, an add-on, a product bought per order) through a platform charge on a payment page (`urls.checkoutSuccess` / `urls.checkoutCancel`); `payments.charge.paid` (with `billingCustomerId`) tells you when to grant it. Put your own reference in `metadata` (read it back from the `PaymentCharge` row in your `payments.charge.paid` handler) and pass a stable `requestId` so a retried request returns the same charge.

An app that sells only one-off purchases configures billing without plans (payments 0.2.1+):

```ts
billing: { customer: 'user' },          // no plans: nothing to subscribe to, nothing in the catalog
urls: {
  checkoutSuccess: 'https://app.example/orders/{chargeId}/paid',
  checkoutCancel: 'https://app.example/orders/{chargeId}',
},
```

## Tenant safety

Billing customers, subscriptions, invoices, and entitlements are tenant-scoped rows. Webhooks about them come from your platform's own Stripe account, so the route finds their tenant from the metadata stamped on each Stripe object (or the local row of their customer or subscription); an event naming an unknown object is recorded as ignored (`unknown_platform_object`).
