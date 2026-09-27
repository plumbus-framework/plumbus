# @plumbus/payments — Framework Instructions for AI Agents

`@plumbus/payments` moves money for a Plumbus app through a payment provider, in two independent ways:

- **Sellers** — the people who use the app (users or tenants) **charge their own clients**, with the app as the platform in between (a marketplace/Connect setup): payment pages, invoices, saved cards, holds, links, subscriptions, payouts, disputes, and transfers.
- **Billing** — the app **bills its own customers** for plans (a SaaS subscription): prices, seats, usage meters (e.g. AI tokens), entitlements, and the billing portal.

It is provider-neutral; the provider adapter (`@plumbus/payments-stripe`) does the vendor calls.

**Peers:** `"@plumbus/core": "0.7.x"` (copy literally; see `node_modules/@plumbus/core/instructions/peer-dependencies.md`) and optional `"fastify": "^5.0.0"` for the webhook route. Core **0.7.7+** is required (`field.bigint()` for amounts, and discovery of exported collections such as `payments.capabilities`).

## What it gives you

| Piece | What it is |
|---|---|
| `createPayments(config)` | Validates options; returns `capabilities` (only those the config turns on), `entities`, `events`, `platform` and `billing` helpers, `effects`, `catalog`, `diagnose`, `setupWebhooks`, `syncCatalog`, `checkCatalog` |
| Capabilities | Sellers: onboarding, charges (pages, invoices, holds, saved cards), clients and the client portal, links, subscriptions, disputes, payouts, transfers. Billing: plans, subscribe, change, cancel, portal, entitlements. Internal: `recordProviderEvent`, `processProviderEvent`, `applyProviderState`. Full list: [capabilities-and-events.md](./capabilities-and-events.md) |
| Entities (14) | `PaymentMerchantAccount`, `PaymentClient`, `PaymentCharge`, `PaymentRefund`, `PaymentDispute`, `PaymentMethod`, `PaymentSubscription`, `PaymentInvoice`, `PaymentLink`, `PaymentTransfer`, `PaymentPayout`, `PaymentBillingCustomer`, `PaymentEntitlement`, `PaymentProviderEvent` — all in `paymentEntities` |
| Events (25) | `payments.merchant.*`, `payments.charge.*` (created, authorized, actionRequired, paid, failed, expired, canceled, refunded), `payments.refund.failed`, `payments.dispute.*`, `payments.paymentMethod.saved`, `payments.subscription.*`, `payments.invoice.*`, `payments.transfer.*`, `payments.payout.*`, `payments.entitlements.updated` (+ internal `payments.provider.eventReceived`) — all in `paymentEvents` |
| `registerPaymentRoutes(app, routeConfig, payments)` | The webhook route (raw body, signature check, ledger) |
| `@plumbus/payments/testing` | `createFakePaymentProvider`, `createPaymentsTestContext`, `deliverTestWebhook`, `withAuth` |

All capabilities have domain `payments`, so canonical names are `payments.createCharge` etc.

## How money flows

1. A seller calls `startMerchantOnboarding` → a provider account is created for them (asking for card payments, transfers, or both, per their charge type) and they finish onboarding on the provider's page (or in embedded components).
2. The provider reports progress by webhook → the worker updates `PaymentMerchantAccount` → `payments.merchant.updated`.
3. The seller calls `createCharge` → the client gets a payment page (hosted link or embedded), an invoice, or is charged on a saved card. **Direct** charges live on the seller's account with your platform fee; **destination** charges live on your platform and pay the seller at once.
4. The client pays → webhook → the worker re-reads the provider and marks the charge paid → `payments.charge.paid`.
5. Refunds, disputes, subscriptions, invoices, transfers, payouts, and entitlements follow the same webhook path.

Events from the platform's own account (destination and platform charges, your plans, transfers) carry no seller; the webhook route finds their tenant from the metadata this package stamps on every provider object, or from the local row of their customer, payment, or subscription.

The webhook route only verifies, records, and queues; `processProviderEvent` (an eventHandler) re-reads the provider in the worker, and `applyProviderState` writes the local rows and emits events in one transaction. Duplicate, out-of-order, and concurrently processed webhooks are harmless: each transition is written with a compare-and-set and emits its event once. A redelivered event whose processing had failed is queued again.

Provider packages (`src/types/provider.ts`): every call gets a `ChargeRouting` (`flow`, `sellerAccountId`, `onBehalfOf`, `transferGroup`) or the account its object lives on (`sellerAccountId`, null = the platform). `verifyWebhook` returns `routing` hints (the `plumbus_tenant_id` metadata, customer, payment, subscription) for platform-account events. `resolveEvent` lists a charge change before its refunds and disputes (they are matched by the payment id the charge records) and a subscription before its invoices, reports each change with the account it was read from (the worker ignores a change from the wrong account), keeps a charge's provider id stable per collection (page, invoice, or payment), and returns `null` for amounts its read does not include, so the stored values are kept. Optional methods back optional features; `createPayments()` refuses a config that turns on a feature whose methods are missing. Implement `findRefund` (look up by the local id sent as `reference`) so refunds whose creation outcome was lost in a crash can be settled.

## File map (src/)

| Concern | File |
|---|---|
| Config schema (every option, with descriptions) | `src/config/schema.ts` |
| Defaults + general rules | `src/config/normalize.ts` |
| Provider contract | `src/types/provider.ts` |
| Entities / events | `src/entities/index.ts`, `src/events/index.ts` |
| Seller capabilities | `src/capabilities/merchant.ts` |
| Charge + refund capabilities | `src/capabilities/charges.ts` |
| Clients, saved methods, portal | `src/capabilities/clients.ts` |
| Links, subscriptions, disputes, payouts, transfers | `src/capabilities/{links,subscriptions,disputes,payouts,transfers}.ts` |
| Your plans | `src/capabilities/billing.ts`, `src/runtime/billing.ts` (helpers, catalog, AI bridge) |
| Platform charges and transfers | `src/runtime/platform.ts` |
| Creating, capturing, canceling, refunding charges | `src/runtime/charge-engine.ts` |
| Subscriptions | `src/runtime/subscription-engine.ts` |
| Internal webhook capabilities | `src/capabilities/internal.ts` |
| Applying provider state (ordering, dedupe) | `src/runtime/apply-state.ts` |
| Webhook route / ingest (tenant routing) | `src/runtime/webhook-route.ts`, `src/runtime/ingest.ts` |
| Fee math, owner resolution, routing, views | `src/runtime/runtime.ts` |

## Critical rules

- **Never call the provider SDK directly for money movement.** Use the capabilities (via the generated client from the browser, or `ctx.capabilities.invoke('payments.createCharge', …)` from app capabilities with `effects.capabilities` declared) or the `payments.platform` / `payments.billing` helpers (with `...payments.effects.platform` / `.billing` in your effects). They enforce access, ownership, audit, idempotency, and fees.
- **Gate features by plan on the server** with `payments.billing.hasFeature(ctx, key)`; the browser's copy of `getEntitlements` is for display.
- **Never trust the success redirect.** `urls.checkoutSuccess` is a thank-you page. Deliver on `payments.charge.paid`.
- **Never accept amounts or fees from the browser as trusted.** The seller chooses the amount; the fee comes from `platformFee` on the server. If the amount is decided by your app (a fixed price), call `createCharge` from your own capability with the server-side amount.
- **Owners come from auth.** The seller is `ctx.auth.userId` (`seller.owner: 'user'`) or `ctx.auth.tenantId` (`'tenant'`); there is no input to act for someone else. All entities are tenant-scoped (except the event ledger).
- **Amounts are integers in minor units.** 5000 = $50.00 for `usd`; 5000 = ¥5000 for `jpy`. Currencies are lowercase ISO codes.
- **Register everything.** Missing entities → "Entity … is not registered"; missing events → emit failures; missing `processProviderEvent` → webhooks never apply. Run the worker.
- **Do not list `payments-webhook` in your own access policies.** It is the service account the webhook route and worker run as.
- **Dashboard and responsibilities are permanent per seller.** A seller who wants another dashboard needs a new account.
- **Keep `webhooks.storePayload` off** unless you need raw bodies; they contain client personal data.
