// ── @plumbus/payments-stripe ──
// Stripe Connect provider for @plumbus/payments on Stripe's newest APIs
// (Accounts v2 sellers, Checkout direct charges, snapshot + thin webhooks).

export {
  STRIPE_API_VERSION,
  STRIPE_DESTINATION_NAMES,
  stripeProvider,
  type StripePaymentProvider,
  type StripeProviderOptions,
} from './provider.js';
export {
  isRelevantStripeEvent,
  STRIPE_SNAPSHOT_EVENTS,
  STRIPE_THIN_EVENTS,
  verifyStripeWebhook,
} from './events.js';
export { stripeDefaultResponsibilities, validateStripeConfig } from './config-rules.js';
export { mapAccount, mapDispute, mapRefund, mapSession, toDisputeStatus } from './mapping.js';
export { keyMode, type SecretSource } from './secrets.js';
