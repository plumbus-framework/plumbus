# Wiring @plumbus/payments into an app

Follow every step; payments only works when all pieces are registered.

## 1. Install

```bash
pnpm add @plumbus/payments @plumbus/payments-stripe
```

Requires `@plumbus/core` **0.7.7+**. Do not add `stripe` to the app — the provider package brings it.

## 2. Create the payments object — `app/payments/index.ts`

```ts
import { createPayments } from '@plumbus/payments';
import { stripeProvider } from '@plumbus/payments-stripe';

export const payments = createPayments({
  provider: stripeProvider({
    secretKey: () => process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecrets: () => (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
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

- Pass secrets as **functions** so `plumbus generate` and migrations can import this file without keys.
- The export must be named `payments` (or be the default export): `plumbus payments doctor` loads it.
- Choose options with [options.md](./options.md). Invalid combinations throw at startup.

## 3. Register capabilities — `app/capabilities/payments.ts`

```ts
import { payments } from '../payments/index.js';

export const {
  startMerchantOnboarding,
  createMerchantSession,
  getMerchantAccount,
  syncMerchantAccount,
  openMerchantDashboard,
  createCharge,
  listCharges,
  getCharge,
  refundCharge,
  recordProviderEvent,
  processProviderEvent,
  applyProviderState,
} = payments.capabilities;
```

Export **all twelve**. The last three are internal (system-only) but required: `processProviderEvent` is the worker's webhook consumer.

## 4. Register entities and events

```ts
// app/entities/payments.ts
export {
  paymentMerchantAccountEntity,
  paymentClientEntity,
  paymentChargeEntity,
  paymentRefundEntity,
  paymentDisputeEntity,
  paymentProviderEventEntity,
} from '@plumbus/payments';

// app/events/payments.ts
export {
  merchantUpdatedEvent,
  chargeCreatedEvent,
  chargePaidEvent,
  chargeFailedEvent,
  chargeExpiredEvent,
  chargeRefundedEvent,
  refundFailedEvent,
  disputeOpenedEvent,
  disputeUpdatedEvent,
  disputeClosedEvent,
  providerEventReceivedEvent,
} from '@plumbus/payments';
```

Then generate and apply migrations:

```bash
plumbus generate && plumbus migrate generate && plumbus migrate apply
```

## 5. Mount the webhook route — `app/server.ts`

```ts
import { registerPaymentRoutes } from '@plumbus/payments';
import { payments } from './payments/index.js';

export function onRoutesRegistered(app, routeConfig) {
  registerPaymentRoutes(app, routeConfig, payments);
}
```

The route is `POST /payments/webhooks/stripe` (change with `webhooks.path`). It keeps the raw body only inside its own plugin; JSON parsing elsewhere is unchanged. It needs no auth cookie or CSRF token — providers sign each request.

## 6. Run the worker

Webhooks are applied by `payments.processProviderEvent` in the worker (`plumbus worker`, or a combined role). Without a worker, events are recorded but charges never become paid.

## 7. Create webhook destinations and check the setup

```bash
plumbus payments webhooks setup --url https://api.example.com/payments/webhooks/stripe
# store both printed signing secrets in STRIPE_WEBHOOK_SECRETS (comma-separated)
plumbus payments doctor --live --webhook-url https://api.example.com/payments/webhooks/stripe
```

For local development with the Stripe CLI see `node_modules/@plumbus/payments-stripe/instructions/webhooks.md`.

## 8. Build the screens (your app's UI)

- "Connect payments": call `startMerchantOnboarding` and redirect to `onboardingUrl`.
- Onboarding return page (`urls.onboardingReturn`): call `syncMerchantAccount` and show the status.
- Refresh page (`urls.onboardingRefresh`): call `startMerchantOnboarding` again and redirect.
- "Request payment": call `createCharge` and show or send `charge.url`.
- Payments list: `listCharges` / `getCharge`; refunds: `refundCharge`.
- Sellers with `dashboard: 'none'` need your app to render the provider's embedded components (`createMerchantSession`).
