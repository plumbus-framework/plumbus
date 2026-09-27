# @plumbus/payments — Framework Instructions for AI Agents

`@plumbus/payments` lets the people who use a Plumbus app **charge their own clients** through a payment provider, with the app as the platform in between (a marketplace/SaaS "Connect" setup). It is provider-neutral; the provider adapter (`@plumbus/payments-stripe`) does the vendor calls.

**Peers:** `"@plumbus/core": "0.7.x"` (copy literally; see `node_modules/@plumbus/core/instructions/peer-dependencies.md`) and optional `"fastify": "^5.0.0"` for the webhook route. Core **0.7.6+** is required (it adds `field.bigint()`, used for amounts).

**Do not use this package** to bill your own users for the app itself (subscriptions to your SaaS) — that is not part of this release. Do not use it for one-off internal transfers.

## What it gives you

| Piece | What it is |
|---|---|
| `createPayments(config)` | Validates options, returns capabilities bound to the provider |
| Capabilities | `startMerchantOnboarding`, `createMerchantSession`, `getMerchantAccount`, `syncMerchantAccount`, `openMerchantDashboard`, `createCharge`, `listCharges`, `getCharge`, `refundCharge` (+ internal `recordProviderEvent`, `processProviderEvent`, `applyProviderState`) |
| Entities | `PaymentMerchantAccount`, `PaymentClient`, `PaymentCharge`, `PaymentRefund`, `PaymentDispute`, `PaymentProviderEvent` |
| Events | `payments.merchant.updated`, `payments.charge.created/paid/failed/expired/refunded`, `payments.refund.failed`, `payments.dispute.opened/updated/closed` (+ internal `payments.provider.eventReceived`) |
| `registerPaymentRoutes(app, routeConfig, payments)` | The webhook route (raw body, signature check, ledger) |
| `@plumbus/payments/testing` | `createFakePaymentProvider`, `createPaymentsTestContext`, `deliverTestWebhook`, `withAuth` |

All capabilities have domain `payments`, so canonical names are `payments.createCharge` etc.

## How money flows

1. A seller calls `startMerchantOnboarding` → a provider account is created for them and they finish onboarding on the provider's page (or in embedded components).
2. The provider reports progress by webhook → the worker updates `PaymentMerchantAccount` → `payments.merchant.updated`.
3. The seller calls `createCharge` → the client gets a provider-hosted payment link on the **seller's** account (direct charge), with your platform fee.
4. The client pays → webhook → the worker re-reads the provider and marks the charge paid → `payments.charge.paid`.
5. Refunds (`refundCharge`) and disputes follow the same webhook path.

The webhook route only verifies, records, and queues; `processProviderEvent` (an eventHandler) re-reads the provider in the worker, and `applyProviderState` writes the local rows and emits events in one transaction. Duplicate and out-of-order webhooks are harmless.

## File map (src/)

| Concern | File |
|---|---|
| Config schema (every option, with descriptions) | `src/config/schema.ts` |
| Defaults + general rules | `src/config/normalize.ts` |
| Provider contract | `src/types/provider.ts` |
| Entities / events | `src/entities/index.ts`, `src/events/index.ts` |
| Seller capabilities | `src/capabilities/merchant.ts` |
| Charge + refund capabilities | `src/capabilities/charges.ts` |
| Internal webhook capabilities | `src/capabilities/internal.ts` |
| Applying provider state (ordering, dedupe) | `src/runtime/apply-state.ts` |
| Webhook route / ingest | `src/runtime/webhook-route.ts`, `src/runtime/ingest.ts` |
| Fee math, owner resolution, views | `src/runtime/runtime.ts` |

## Critical rules

- **Never call the provider SDK directly for money movement.** Use `createCharge` / `refundCharge` (via the generated client from the browser, or `ctx.capabilities.invoke('payments.createCharge', …)` from app capabilities with `effects.capabilities` declared). They enforce access, ownership, audit, idempotency, and fees.
- **Never trust the success redirect.** `urls.checkoutSuccess` is a thank-you page. Deliver on `payments.charge.paid`.
- **Never accept amounts or fees from the browser as trusted.** The seller chooses the amount; the fee comes from `platformFee` on the server. If the amount is decided by your app (a fixed price), call `createCharge` from your own capability with the server-side amount.
- **Owners come from auth.** The seller is `ctx.auth.userId` (`seller.owner: 'user'`) or `ctx.auth.tenantId` (`'tenant'`); there is no input to act for someone else. All entities are tenant-scoped (except the event ledger).
- **Amounts are integers in minor units.** 5000 = $50.00 for `usd`; 5000 = ¥5000 for `jpy`. Currencies are lowercase ISO codes.
- **Register everything.** Missing entities → "Entity … is not registered"; missing events → emit failures; missing `processProviderEvent` → webhooks never apply. Run the worker.
- **Do not list `payments-webhook` in your own access policies.** It is the service account the webhook route and worker run as.
- **Dashboard and responsibilities are permanent per seller.** A seller who wants another dashboard needs a new account.
- **Keep `webhooks.storePayload` off** unless you need raw bodies; they contain client personal data.
