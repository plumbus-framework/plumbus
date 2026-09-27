# Payments use cases — which features to combine

**Previous:** [options.md](./options.md) · **Next:** [billing.md](./billing.md)

Common kinds of apps, what their users need from payments, and the config and calls that deliver it. Every option is explained in [options.md](./options.md).

## Contents

1. [Independent professionals charge their clients](#independent-professionals-charge-their-clients)
2. [A branded marketplace](#a-branded-marketplace)
3. [A cart split across several sellers](#a-cart-split-across-several-sellers)
4. [Bookings with deposits and no-show fees](#bookings-with-deposits-and-no-show-fees)
5. [Invoicing businesses](#invoicing-businesses)
6. [Memberships sold by your users](#memberships-sold-by-your-users)
7. [Donations, tips, and pay-what-you-want](#donations-tips-and-pay-what-you-want)
8. [A SaaS billing its own customers](#a-saas-billing-its-own-customers)
9. [Usage-based AI billing](#usage-based-ai-billing)
10. [Everything inside your app](#everything-inside-your-app)

---

## Independent professionals charge their clients

Tutors, coaches, therapists, freelancers. Each one is their own business and runs their own Stripe account.

```ts
seller: { owner: 'user' },
access: { sellers: { roles: ['pro'] } },
dashboards: { full: true },              // direct charges: the pro is the merchant of record
platformFee: { percent: 5 },
invoices: { daysUntilDue: 14 },
```

- Price the session in your own capability and call `payments.createCharge` with the server-side amount and a stable `requestId` ([example](./getting-started.md)); deliver on `payments.charge.paid`.
- Clients who prefer an invoice: `createCharge({ collection: 'invoice', client: { email } })`.
- Lowest risk for you: the pro pays Stripe's fees, Stripe covers negative balances, refunds and disputes hit the pro's balance.

## A branded marketplace

Sellers work under your brand, with a light dashboard or none; clients buy from *you*.

```ts
seller: { owner: 'user' },
dashboards: { express: true },            // destination charges by default
platformFee: { percent: 10 },
refunds: { reverseTransfer: true },        // refunds come out of the seller's share
payouts: { schedule: { interval: 'weekly', weeklyAnchor: 'friday', delayDays: 7 }, instant: true },
```

- Your platform is the merchant of record: it pays Stripe's fees (your `platformFee` must cover them), handles disputes (`listDisputes`, `respondToDispute`), and holds a buffer through the payout delay.
- `destination.onBehalfOf: true` puts the seller's name on the client's statement instead of yours.
- Sellers see their payouts (`listPayouts`) and can take money early with `createInstantPayout`.

## A cart split across several sellers

A client pays once for items from several sellers — a group class taught by two tutors, a cart with two shops.

```ts
seller: { owner: 'user' },
dashboards: { express: true },
transfers: { enabled: true },
```

```ts
// Your checkout capability
const { charge } = await payments.platform.createCharge(ctx, {
  items: cart.lines.map((l) => ({ name: l.title, unitAmount: l.price, quantity: l.qty })),
  currency: 'usd', description: `Order ${cart.id}`,
  client: { email: buyer.email }, transferGroup: `order:${cart.id}`,
  metadata: { orderId: cart.id }, requestId: `order:${cart.id}`,
});

// eventHandler on payments.charge.paid (flow 'platform')
for (const share of sharesOf(order)) {
  await payments.platform.transferToSeller(ctx, {
    merchantAccountId: share.merchantAccountId, amount: share.amount, currency: 'usd',
    chargeId: input.chargeId, requestId: `order-share:${input.chargeId}:${share.sellerId}`,
  });
}
```

A transfer tied to its charge waits for the charge's funds and can never exceed it. Refunds are yours to split: refund the charge with `payments.platform.refundCharge`, then `payments.platform.reverseTransfer` each seller's part.

## Bookings with deposits and no-show fees

Hold money when a booking is made, charge the rest later, charge a no-show fee without the client.

```ts
dashboards: { full: true },
checkout: { submitType: 'book' },
```

- Deposit held, not taken: `createCharge({ amount, capture: 'manual' })` → `payments.charge.authorized` → `captureCharge({ amount })` for what is due (the fee is recomputed on it) or `cancelCharge` to release it. Card holds last about a week (`captureBefore`).
- Keep the card: `createCharge({ …, saveMethod: true })`, or `saveClientPaymentMethod({ client })` for a card-only page.
- No-show fee: `chargeSavedMethod({ clientId, amount, description, requestId })`. When the bank wants the client present, the charge becomes `requires_action` with a `url` to send them; `payments.charge.actionRequired` tells you.
- Clients update their card in the provider's portal: `createClientPortalSession({ clientId })`.

## Invoicing businesses

B2B clients pay by invoice, often later.

```ts
seller: { owner: 'tenant' },
dashboards: { full: true },
invoices: { daysUntilDue: 30 },
checkout: { automaticTax: true },
```

`createCharge({ collection: 'invoice', items, client: { email, name } })` emails an invoice with its own payment page; `payments.charge.paid` arrives when it is paid, and `cancelCharge` voids one that should not be paid.

## Memberships sold by your users

A gym, a studio, or a tutor sells a monthly plan to their clients.

```ts
dashboards: { full: true },
subscriptions: { enabled: true, platformFeePercent: 5 },
urls: { portalReturn: 'https://app.example/account', /* … */ },
```

`createSubscription({ client, currency, items: [{ name, unitAmount, interval: 'month' }], trialDays })` returns `subscription.checkoutUrl`. Renewals arrive as `payments.invoice.paid` / `paymentFailed` and status changes as `payments.subscription.updated` (`past_due`, `canceled`). `cancelSubscription` cancels at the period end, `resumeSubscription` undoes that, and clients manage their own in the portal.

## Donations, tips, and pay-what-you-want

```ts
checkout: { submitType: 'donate' },
```

`createCharge({ customAmount: { minimum: 500, preset: 1500 }, … })` lets the client choose; the charge takes the paid amount. A reusable page to share anywhere: `createPaymentLink({ customAmount: { minimum: 500 } })` — every payment through it becomes its own charge with `linkId`. Link fees are fixed when the link is created.

## A SaaS billing its own customers

Your app charges organizations for plans; there may be no sellers at all.

```ts
access: { billing: { roles: ['owner'] } },
billing: {
  customer: 'tenant',
  plans: {
    starter: { name: 'Starter', features: ['projects'], prices: { monthly: { amount: 900, currency: 'usd', interval: 'month' } } },
    team: {
      name: 'Team', features: ['projects', 'ai', 'sso'], trialDays: 14,
      prices: {
        monthly: { amount: 1500, currency: 'usd', interval: 'month', perSeat: true },
        yearly: { amount: 15000, currency: 'usd', interval: 'year', perSeat: true },
      },
    },
  },
  features: { sso: { name: 'Single sign-on' } },
},
urls: { billingSuccess: '…/billing/done', billingCancel: '…/billing', billingPortalReturn: '…/billing' },
```

Run `plumbus payments catalog sync` after each change to `billing`. Your pricing page reads `listPlans`; `subscribeToPlan({ plan, price, quantity })` sends the owner to checkout; gate features on the server with `payments.billing.hasFeature(ctx, 'sso')`; keep seats in step with `payments.billing.setSeats(ctx, { quantity: memberCount })` when members join or leave. See [billing.md](./billing.md).

## Usage-based AI billing

Charge for what your AI features cost, on top of a plan.

```ts
billing: {
  customer: 'tenant',
  plans: { pro: { name: 'Pro', features: ['ai'], prices: { monthly: { amount: 2000, currency: 'usd', interval: 'month' } }, meters: ['aiTokens'] } },
  meters: { aiTokens: { name: 'AI tokens', eventName: 'ai_tokens', unitAmount: '0.002', currency: 'usd' } },
},
```

```ts
// app/server.ts — every AI call of a tenant is metered, tokens or cost
export const onAICostRecorded = payments.billing.aiUsageBridge({ meter: 'aiTokens', value: 'tokens' });
```

Or record usage yourself: `payments.billing.recordUsage(ctx, { meter: 'aiTokens', value, identifier })`. Usage is billed at the end of each period on the plan's invoice.

## Everything inside your app

No Stripe dashboard anywhere; sellers and clients never leave your pages.

```ts
dashboards: { none: true },
onboarding: { modes: ['embedded'] },
checkout: { ui: 'embedded' },
embedded: { allowRefunds: false },
```

Onboarding, payments, payouts, and disputes render with the provider's embedded components (`createMerchantSession`); payment pages mount from `charge.checkout`. Most to build; see [options.md](./options.md#dashboardsnone) for what your platform takes on.
