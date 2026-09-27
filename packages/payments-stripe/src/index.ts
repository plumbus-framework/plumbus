// ── @plumbus/payments-stripe ──
// Stripe Connect provider for @plumbus/payments on Stripe's newest APIs
// (Accounts v2 sellers, Checkout, Billing, snapshot + thin webhooks).

export {
  STRIPE_API_VERSION,
  STRIPE_DESTINATION_NAMES,
  stripeProvider,
  type StripePaymentProvider,
  type StripeProviderOptions,
} from './provider.js';
export {
  isRelevantStripeEvent,
  routingOf,
  STRIPE_SNAPSHOT_EVENTS,
  STRIPE_SNAPSHOT_SOURCES,
  STRIPE_THIN_EVENTS,
  verifyStripeWebhook,
} from './events.js';
export { stripeDefaultResponsibilities, validateStripeConfig } from './config-rules.js';
export {
  mapAccount,
  mapDispute,
  mapIntent,
  mapInvoice,
  mapInvoiceCharge,
  mapPaymentMethod,
  mapPayout,
  mapPayoutSchedule,
  mapRefund,
  mapSession,
  mapSubscription,
  mapTransfer,
  toDisputeStatus,
} from './mapping.js';
export { catalogProductId, featureLookupKey } from './catalog.js';
export { keyMode, type SecretSource } from './secrets.js';
