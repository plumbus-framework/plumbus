# Testing payments

Never call a real provider in unit tests. Use `@plumbus/payments/testing` (it builds on `@plumbus/core/testing`, so import it only inside Vitest / `plumbus test`, not from plain `node` scripts):

| Export | Use |
|---|---|
| `createFakePaymentProvider(options?)` | In-memory provider with lifecycle helpers and HMAC-signed webhooks |
| `createPaymentsTestContext(payments, options?)` | `createTestContext` with every payments entity and capability registered |
| `deliverTestWebhook(payments, ctx, delivery, { process? })` | Verify → record → run the worker step, exactly like production |
| `withAuth(ctx, auth)` | Same data/events, another identity (a second seller, the service account) |

## Recipe

```ts
import { executeCapability } from '@plumbus/core';
import type { MockEventService } from '@plumbus/core/testing';
import { createPayments } from '@plumbus/payments';
import {
  createFakePaymentProvider,
  createPaymentsTestContext,
  deliverTestWebhook,
} from '@plumbus/payments/testing';

const fake = createFakePaymentProvider();
const payments = createPayments({ ...appPaymentsConfig, provider: fake });
const ctx = createPaymentsTestContext(payments, {
  auth: { userId: 'seller-1', tenantId: 'tenant-a', roles: ['seller'] },
});
const run = async (name: keyof typeof payments.capabilities, input: unknown) => {
  const result = await executeCapability(payments.capabilities[name] as any, ctx, input);
  if (!result.success) throw result.error;
  return result.data as any;
};

await run('startMerchantOnboarding', {});
const accountId = [...fake.accounts.keys()][0]!;
fake.completeOnboarding(accountId);
await deliverTestWebhook(payments, ctx, fake.event('account', accountId));

const { charge } = await run('createCharge', { amount: 5000, currency: 'usd', description: 'Lesson' });
const providerCharge = [...fake.charges.values()][0]!;
fake.payCharge(providerCharge.id);
await deliverTestWebhook(payments, ctx, fake.event('charge', providerCharge.id));

const paid = (ctx.events as MockEventService).emitted.filter((e) => e.eventName === 'payments.charge.paid');
```

Fake helpers: `completeOnboarding`, `restrictAccount`, `closeAccount`, `payCharge`, `setChargeStatus`, `settleRefund`, `openDispute`, `setDisputeStatus`, `failNext(method, error)`, `event(objectType, id, { type, livemode, eventId })`, plus `calls` (every provider call with its input).

## What to test in your app

- Your `payments.charge.paid` handler grants exactly once (deliver the same `fake.event(...)` twice; the second returns `status: 'duplicate'`).
- Your capability that invokes `payments.createCharge` passes the server-side amount and a stable `requestId`.
- Sellers without `access.sellers` get `forbidden`; another seller's `chargeId` gets `notFound`.

Stripe-specific tests (real signatures, request shapes): `node_modules/@plumbus/payments-stripe/instructions/testing.md`.
