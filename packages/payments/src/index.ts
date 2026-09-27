// ── @plumbus/payments ──
// Provider-neutral payments for Plumbus apps: sellers connect their own
// provider account and charge their clients; the platform can take a cut.
// Money moves only through capabilities (access policy + audit), provider
// state is mirrored into entities, and apps react to payments.* events.
// Vendor adapters (e.g. @plumbus/payments-stripe) implement PaymentProvider.

export { createPayments } from './runtime/create-payments.js';
export type { PaymentCapabilities, Payments } from './runtime/create-payments.js';
export { registerPaymentRoutes } from './runtime/webhook-route.js';
export type { RegisterPaymentRoutesOptions } from './runtime/webhook-route.js';
export { ingestProviderEvent, paymentsServiceAuth } from './runtime/ingest.js';
export type { IngestOutcome } from './runtime/ingest.js';
export { PAYMENTS_WEBHOOK_ACTOR, percentOf } from './runtime/runtime.js';
export { deriveMerchantStatus } from './runtime/apply-state.js';
export { listPaymentsConfigOptions, paymentsConfigSchema } from './config/schema.js';

export {
  PaymentEntityName,
  paymentChargeEntity,
  paymentClientEntity,
  paymentDisputeEntity,
  paymentEntities,
  paymentMerchantAccountEntity,
  paymentProviderEventEntity,
  paymentRefundEntity,
} from './entities/index.js';

export {
  chargeCreatedEvent,
  chargeExpiredEvent,
  chargeFailedEvent,
  chargePaidEvent,
  chargeRefundedEvent,
  disputeClosedEvent,
  disputeOpenedEvent,
  disputeUpdatedEvent,
  merchantUpdatedEvent,
  PaymentEventName,
  paymentEvents,
  providerEventReceivedEvent,
  refundFailedEvent,
} from './events/index.js';

export {
  ChargeStatus,
  ChargeType,
  DisputeStatus,
  MerchantComponent,
  MerchantDashboard,
  OnboardingMode,
  RefundStatus,
  Responsibility,
} from './types/provider.js';
export type {
  CreateChargeInput,
  CreateClientInput,
  CreateMerchantAccountInput,
  CreateRefundInput,
  MerchantSession,
  PaymentProvider,
  PaymentsFinding,
  ProviderCharge,
  ProviderDispute,
  ProviderMerchantAccount,
  ProviderRefund,
  ProviderStateChange,
  StoredProviderEvent,
  VerifiedProviderEvent,
  WebhookSetupResult,
} from './types/provider.js';
export type {
  DashboardOption,
  NormalizedPaymentsConfig,
  PaymentsConfig,
  PlatformFeeFunction,
  PlatformFeeInput,
  PlatformFeeRule,
  SellerOwner,
} from './types/config.js';
export type {
  MerchantAccountStatus,
  PaymentChargeRow,
  PaymentClientRow,
  PaymentDisputeRow,
  PaymentMerchantAccountRow,
  PaymentProviderEventRow,
  PaymentRefundRow,
  ProviderEventStatus,
} from './types/records.js';
