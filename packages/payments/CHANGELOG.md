# Changelog

## 0.2.0 — 2026-09-27

### Added

- First release, in the core 0.7.x family. Sellers (users or tenants) connect their own payment-provider account and charge their clients; the platform can take a cut.
- `createPayments()` with a Zod-validated config: seller owner, access policies, dashboards (full / express / none) with fees and losses responsibilities, onboarding modes, countries, currencies, platform fee (rule or function), refund fee policy, checkout lifetime, embedded-component permissions, redirect URLs, webhook route settings, `appId`. Provider rules fail at startup; advice is returned as findings.
- Capabilities `startMerchantOnboarding`, `createMerchantSession`, `getMerchantAccount`, `syncMerchantAccount`, `openMerchantDashboard`, `createCharge`, `listCharges`, `getCharge`, `refundCharge`, and system-only `recordProviderEvent`, `processProviderEvent`, `applyProviderState`.
- Tenant-scoped entities for seller accounts, clients, charges, refunds, disputes (amounts as 64-bit `field.bigint()`), and a webhook ledger; `payments.*` domain events.
- `registerPaymentRoutes()`: raw-body webhook route in its own Fastify plugin, signature verification, live/test mode guard, dedupe, and worker processing that re-reads the provider (duplicates and out-of-order deliveries are harmless).
- Race-safe creation: charges and refunds are saved before the provider call, so webhooks that arrive before the call returns update the same row (no duplicates, no lost state); a rejected provider call leaves no row. Provider references that are not local ids never reach uuid lookups.
- `@plumbus/payments/testing`: fake provider, `createPaymentsTestContext`, `deliverTestWebhook`, `withAuth`.
- Agent instructions and `docs/payments/` (every option documented; a test enforces it).

Requires `@plumbus/core` 0.7.7+ and a provider package such as `@plumbus/payments-stripe`. Verified end to end on the real runtime by `examples/payments-connect-app`.
