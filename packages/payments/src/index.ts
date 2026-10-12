// ── @plumbus/payments ──
// Provider-neutral payments for Plumbus apps: sellers connect their own
// provider account and charge their clients (direct or destination charges,
// payment pages, invoices, saved payment methods, holds, subscriptions,
// payment links); the platform can take a cut, move money itself (platform
// charges and transfers), and bill its own customers for plans.
// Money moves only through capabilities (access policy + audit) or server-side
// helpers, provider state is mirrored into entities, and apps react to
// payments.* events. Vendor adapters (e.g. @plumbus/payments-stripe) implement
// PaymentProvider.

export { createPayments } from './runtime/create-payments.js';
export type { HelperEffects, PaymentCapabilities, Payments } from './runtime/create-payments.js';
export type { PlatformChargeInput, PlatformHelpers, TransferInput } from './runtime/platform.js';
export type { BillingHelpers, UsageInput } from './runtime/billing.js';
export { registerPaymentRoutes } from './runtime/webhook-route.js';
export type { RegisterPaymentRoutesOptions } from './runtime/webhook-route.js';
export { crossTenantLookups, ingestProviderEvent, paymentsServiceAuth } from './runtime/ingest.js';
export type { IngestLookups, IngestOutcome } from './runtime/ingest.js';
export { PAYMENTS_WEBHOOK_ACTOR, percentOf } from './runtime/runtime.js';
export { deriveMerchantStatus, planFromLookupKey } from './runtime/apply-state.js';
export { listPaymentsConfigOptions, paymentsConfigSchema } from './config/schema.js';

export {
  PaymentEntityName,
  paymentBillingCustomerEntity,
  paymentChargeEntity,
  paymentClientEntity,
  paymentDisputeEntity,
  paymentEntitlementEntity,
  paymentEntities,
  paymentInvoiceEntity,
  paymentLinkEntity,
  paymentMerchantAccountEntity,
  paymentMethodEntity,
  paymentPayoutEntity,
  paymentProviderEventEntity,
  paymentRefundEntity,
  paymentSubscriptionEntity,
  paymentTransferEntity,
} from './entities/index.js';

export {
  chargeActionRequiredEvent,
  chargeAuthorizedEvent,
  chargeCanceledEvent,
  chargeCreatedEvent,
  chargeExpiredEvent,
  chargeFailedEvent,
  chargePaidEvent,
  chargeRefundedEvent,
  disputeClosedEvent,
  disputeOpenedEvent,
  disputeUpdatedEvent,
  entitlementsUpdatedEvent,
  invoicePaidEvent,
  invoicePaymentFailedEvent,
  merchantUpdatedEvent,
  PaymentEventName,
  paymentEvents,
  paymentMethodSavedEvent,
  payoutFailedEvent,
  payoutPaidEvent,
  providerEventReceivedEvent,
  refundFailedEvent,
  subscriptionEndedEvent,
  subscriptionStartedEvent,
  subscriptionUpdatedEvent,
  transferCreatedEvent,
  transferReversedEvent,
} from './events/index.js';

export {
  ChargeCollection,
  ChargeFlow,
  ChargeStatus,
  ChargeType,
  DisputeStatus,
  InvoiceStatus,
  MerchantComponent,
  MerchantDashboard,
  OnboardingMode,
  PayoutStatus,
  RefundStatus,
  Responsibility,
  SubscriptionStatus,
} from './types/provider.js';
export type {
  BillingInterval,
  CaptureMode,
  CatalogInput,
  CatalogResult,
  ChargeItem,
  ChargeRouting,
  ChargeSavedMethodInput,
  CheckoutOptions,
  CheckoutPage,
  CheckoutUi,
  CreateChargeInput,
  CreateClientInput,
  CreateInvoiceChargeInput,
  CreateMerchantAccountInput,
  CreatePaymentLinkInput,
  CreateRefundInput,
  CreateSubscriptionCheckoutInput,
  CreateTransferInput,
  CustomAmount,
  DisputeEvidence,
  MerchantSession,
  PaymentProvider,
  PaymentsFinding,
  PayoutSchedule,
  PayoutSettings,
  ProviderCharge,
  ProviderDispute,
  ProviderEventRouting,
  ProviderInvoice,
  ProviderMerchantAccount,
  ProviderPaymentLink,
  ProviderPaymentMethod,
  ProviderPayout,
  ProviderRefund,
  ProviderStateChange,
  ProviderSubscription,
  ProviderSubscriptionItem,
  ProviderTransfer,
  StoredProviderEvent,
  SubscriptionItemInput,
  UpdateSubscriptionInput,
  VerifiedProviderEvent,
  WebhookSetupResult,
} from './types/provider.js';
export type {
  BillingConfig,
  BillingCustomerKind,
  DashboardOption,
  FeeMerchant,
  MeterConfig,
  NormalizedPaymentsConfig,
  PaymentsConfig,
  PlanConfig,
  PlanPriceConfig,
  PlatformFeeFunction,
  PlatformFeeInput,
  PlatformFeeRule,
  SellerOwner,
  SubscriptionFeeFunction,
  SubscriptionFeeInput,
} from './types/config.js';
export type {
  MerchantAccountStatus,
  PaymentBillingCustomerRow,
  PaymentChargeRow,
  PaymentClientRow,
  PaymentDisputeRow,
  PaymentEntitlementRow,
  PaymentInvoiceRow,
  PaymentLinkRow,
  PaymentMerchantAccountRow,
  PaymentMethodRow,
  PaymentPayoutRow,
  PaymentProviderEventRow,
  PaymentRefundRow,
  PaymentSubscriptionRow,
  PaymentTransferRow,
  ProviderEventStatus,
  SubscriptionItemView,
} from './types/records.js';
