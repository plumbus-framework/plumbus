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
  appId: 'my-app',
});
```

- Pass secrets as **functions** so `plumbus generate` and migrations can import this file without keys.
- The export must be named `payments` (or be the default export): `plumbus payments doctor` loads it.
- Choose options with [options.md](./options.md). Invalid combinations throw at startup.

## 3. Register capabilities — `app/capabilities/payments.ts`

```ts
import { payments } from '../payments/index.js';

export const paymentCapabilities = payments.capabilities;
```

One export registers every capability the config turned on (discovery expands exported collections). The three internal ones (`recordProviderEvent`, `processProviderEvent`, `applyProviderState`) are system-only but required: `processProviderEvent` is the worker's webhook consumer. Do not pick capabilities out by name — a feature you enable later would be missing.

## 4. Register entities and events

```ts
// app/entities/payments.ts
export { paymentEntities } from '@plumbus/payments';

// app/events/payments.ts
export { paymentEvents } from '@plumbus/payments';
```

All 14 entities and 25 events are registered whatever features are on; unused tables stay empty.

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

## 7. Create webhook destinations, sync the billing catalog, and check the setup

```bash
plumbus payments webhooks setup --url https://api.example.com/payments/webhooks/stripe
# store both printed signing secrets in STRIPE_WEBHOOK_SECRETS (comma-separated)
plumbus payments catalog sync        # only with `billing`: products, prices, features, meters
plumbus payments doctor --live --webhook-url https://api.example.com/payments/webhooks/stripe
```

Run `webhooks setup` again after upgrading this package: it adds events a newer release needs. Run `catalog sync` on every deploy that changes `billing` (it changes nothing when the catalog already matches); `catalog check` in CI fails when it would.

For local development with the Stripe CLI see `node_modules/@plumbus/payments-stripe/instructions/webhooks.md`.

## 8. Money your own capabilities move (platform charges, billing)

`payments.platform.*` and `payments.billing.*` are server-side helpers for your own capabilities (they have no access policy of their own — yours decides). Spread their effects so the capability runs outside a database transaction during provider calls:

```ts
export const chargeGroupClass = defineCapability({
  name: 'chargeGroupClass',
  kind: 'action',
  domain: 'school',
  input: z.object({ classId: z.string(), studentEmail: z.string().email() }),
  output: z.object({ url: z.string().nullable() }),
  access: { roles: ['school-admin'] },
  effects: { ...payments.effects.platform, ai: false },
  async handler(ctx, input) {
    const { charge } = await payments.platform.createCharge(ctx, {
      amount: 10_000, currency: 'usd', description: 'Group class',
      client: { email: input.studentEmail }, transferGroup: `class:${input.classId}`,
      requestId: `class:${input.classId}:${input.studentEmail}`,
    });
    return { url: charge.url };
  },
});
```

Then, in an `eventHandler` on `payments.charge.paid` (with `flow: 'platform'`), pay each seller with `payments.platform.transferToSeller(ctx, { merchantAccountId, amount, currency, chargeId, requestId })`. Billing: gate features with `payments.billing.hasFeature(ctx, 'ai')`, sync seats with `payments.billing.setSeats(ctx, { quantity })`, meter usage with `payments.billing.recordUsage(ctx, { meter, value, identifier })`, and meter every AI call with the hook in `app/server.ts`:

```ts
export const onAICostRecorded = payments.billing.aiUsageBridge({ meter: 'aiTokens', value: 'tokens' });
```

## 9. Build the screens (your app's UI)

- "Connect payments": call `startMerchantOnboarding` and redirect to `onboardingUrl`.
- Onboarding return page (`urls.onboardingReturn`): call `syncMerchantAccount` and show the status.
- Refresh page (`urls.onboardingRefresh`): call `startMerchantOnboarding` again and redirect.
- "Request payment": call `createCharge` and show or send `charge.url` — or, with `ui: 'embedded'`, mount `charge.checkout` with the provider's embedded checkout.
- Payments list: `listCharges` / `getCharge`; refunds: `refundCharge`; holds: `captureCharge` / `cancelCharge`.
- Features you enabled: invoices (`createCharge({ collection: 'invoice' })`), saved cards (`saveClientPaymentMethod`, `chargeSavedMethod`, `createClientPortalSession`), links (`createPaymentLink`), subscriptions (`createSubscription`), payouts (`listPayouts`, `getPayoutSettings`), disputes (`listDisputes`, `respondToDispute`).
- Your plans: pricing page (`listPlans`), subscribe (`subscribeToPlan` → `subscription.checkoutUrl`), plan settings (`getPlanSubscription`, `changePlan`, `cancelPlanSubscription`, `openBillingPortal`).
- Sellers with `dashboard: 'none'` need your app to render the provider's embedded components (`createMerchantSession`).
