# Getting started with payments

**Next:** [options.md](./options.md)

This walks through letting your users charge their clients with Stripe Connect. To bill your own customers for plans instead (or as well), add `billing` — see [billing.md](./billing.md); the wiring below is the same. For which features fit your kind of app, see [use-cases.md](./use-cases.md).

## 1. Before you write code

- A Stripe account with **Connect** enabled (Dashboard → Connect → get started) and the platform profile completed. Test mode works right away; live mode needs Stripe's review.
- Decide the business terms with whoever owns the app — see [options.md](./options.md): who the seller is (user or tenant), which dashboards to offer, direct or destination charges, who covers losses, your cut.

## 2. Install

```bash
pnpm add @plumbus/payments @plumbus/payments-stripe
```

Needs `@plumbus/core` 0.7.7+.

## 3. Configure — `app/payments/index.ts`

```ts
import { createPayments } from '@plumbus/payments';
import { stripeProvider } from '@plumbus/payments-stripe';

export const payments = createPayments({
  provider: stripeProvider({
    secretKey: () => process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecrets: () => (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean),
  }),
  seller: { owner: 'user' },
  access: { sellers: { roles: ['seller'] } },
  dashboards: { full: true },
  countries: { default: 'US' },
  platformFee: { percent: 5 },
  urls: {
    onboardingReturn: 'https://app.example.com/payments/connected',
    onboardingRefresh: 'https://app.example.com/payments/connect',
    checkoutSuccess: 'https://app.example.com/pay/{chargeId}/thanks',
    checkoutCancel: 'https://app.example.com/pay/{chargeId}',
  },
});
```

Invalid combinations (for example Express with Stripe-covered losses) throw when this file loads; advice is logged as warnings when the webhook route starts.

## 4. Register the pieces

```ts
// app/capabilities/payments.ts — every capability the config turns on
import { payments } from '../payments/index.js';
export const paymentCapabilities = payments.capabilities;

// app/entities/payments.ts
export { paymentEntities } from '@plumbus/payments';

// app/events/payments.ts
export { paymentEvents } from '@plumbus/payments';

// app/server.ts
import { registerPaymentRoutes } from '@plumbus/payments';
import { payments } from './payments/index.js';
export function onRoutesRegistered(app, routeConfig) {
  registerPaymentRoutes(app, routeConfig, payments);
}
```

```bash
plumbus generate && plumbus migrate generate && plumbus migrate apply
```

Run the worker too (`plumbus worker`): webhooks are applied there.

## 5. Connect Stripe's webhooks

```bash
plumbus payments webhooks setup --url https://api.example.com/payments/webhooks/stripe
```

Store the two printed signing secrets in `STRIPE_WEBHOOK_SECRETS` (comma-separated). With `billing`, create your plans at Stripe (and again after each change to them):

```bash
plumbus payments catalog sync
```

Then check everything:

```bash
plumbus payments doctor --live --webhook-url https://api.example.com/payments/webhooks/stripe
```

Locally, forward events with the Stripe CLI — see [webhooks.md](./webhooks.md#local-development).

## 6. Build the seller screens

1. **Connect payments** — call `startMerchantOnboarding`, redirect to `onboardingUrl`.
2. **Return page** (`urls.onboardingReturn`) — call `syncMerchantAccount`, show `status` and `requirementsDue`.
3. **Request payment** — call `createCharge({ amount, currency, description, client })` (or `items` for several lines), show or send `charge.url`.
4. **Payments list** — `listCharges`, `getCharge`, `refundCharge`.
5. **What else you turned on** — invoices, holds, saved cards and the client portal, links, subscriptions, payouts, disputes: [capabilities-and-events.md](../../packages/payments/instructions/capabilities-and-events.md).

## 7. React to payments

```ts
export const grantAccessOnPayment = defineCapability({
  name: 'grantAccessOnPayment',
  kind: 'eventHandler',
  domain: 'lessons',
  trigger: { event: 'payments.charge.paid' },
  input: z.object({ chargeId: z.string() }).passthrough(),
  output: z.object({ granted: z.boolean() }),
  access: { roles: ['system'] },
  effects: { data: ['PaymentCharge', 'Booking'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const charge = await ctx.data.PaymentCharge.findById(input.chargeId);
    const bookingId = charge?.metadata?.bookingId;
    if (!bookingId) return { granted: false };
    await ctx.data.Booking.update(bookingId, { status: 'paid' });
    return { granted: true };
  },
});
```

Deliver on `payments.charge.paid`, never on the success redirect. Handlers must be idempotent (events are at least once).
