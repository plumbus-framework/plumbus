// ── Row shapes of the payments entities ──
// What `ctx.data.Payment*` returns. Exported so app code that reads payments
// through ctx.data gets typed rows.

import type { BillingCustomerKind, SellerOwner } from './config.js';
import type {
  BillingInterval,
  CaptureMode,
  ChargeCollection,
  ChargeFlow,
  ChargeItem,
  ChargeStatus,
  ChargeType,
  CheckoutUi,
  DisputeStatus,
  InvoiceStatus,
  MerchantDashboard,
  PayoutStatus,
  RefundStatus,
  Responsibility,
  SubscriptionStatus,
} from './provider.js';

export type MerchantAccountStatus = 'onboarding' | 'active' | 'restricted' | 'closed';

interface Timestamps {
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PaymentMerchantAccountRow extends Timestamps {
  id: string;
  tenantId: string;
  ownerType: SellerOwner;
  ownerId: string;
  provider: string;
  providerAccountId: string;
  dashboard: MerchantDashboard;
  /** How this seller's charges move money, fixed at onboarding. */
  chargeType: ChargeType;
  feesCollector: Responsibility;
  lossesCollector: Responsibility;
  country: string | null;
  defaultCurrency: string | null;
  status: MerchantAccountStatus;
  chargesEnabled: boolean;
  transfersEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[] | null;
  requirementsPastDue: string[] | null;
  disabledReason: string | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentClientRow extends Timestamps {
  id: string;
  tenantId?: string;
  /** The seller whose client this is, or null for a client of the platform. */
  merchantAccountId: string | null;
  provider: string;
  providerClientId: string;
  /** The provider customer lives on the platform account (destination and platform charges). */
  onPlatform: boolean;
  reference: string | null;
  userId: string | null;
  email: string | null;
  name: string | null;
}

export interface PaymentChargeRow extends Timestamps {
  id: string;
  tenantId?: string;
  /** The seller paid, or null for platform charges. */
  merchantAccountId: string | null;
  clientId: string | null;
  provider: string;
  flow: ChargeFlow;
  collection: ChargeCollection;
  ui: CheckoutUi | null;
  capture: CaptureMode;
  /** Provider object for the payment attempt: checkout page, invoice, or payment. */
  providerChargeId: string;
  providerPaymentId: string | null;
  requestId: string | null;
  status: ChargeStatus;
  /** Requested amount: the items' total before discounts and tax. */
  amount: number;
  /** The client chose the amount (the requested amount is the preset or minimum). */
  customAmount: boolean;
  /** What the client paid: after discounts and tax. */
  amountTotal: number | null;
  amountDiscount: number;
  amountTax: number;
  currency: string;
  platformFeeAmount: number;
  amountRefunded: number;
  amountCapturable: number;
  captureBefore: Date | null;
  description: string;
  items: ChargeItem[] | null;
  url: string | null;
  clientSecret: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  clientEmail: string | null;
  paymentMethodId: string | null;
  saveMethod: boolean;
  failureCode: string | null;
  transferGroup: string | null;
  linkId: string | null;
  billingCustomerId: string | null;
  createdBy: string | null;
  metadata: Record<string, string> | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentRefundRow extends Timestamps {
  id: string;
  tenantId?: string;
  chargeId: string;
  merchantAccountId: string | null;
  provider: string;
  providerRefundId: string;
  requestId: string | null;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  failureReason: string | null;
  requestedBy: string | null;
  syncedAt: Date | null;
}

export interface PaymentDisputeRow extends Timestamps {
  id: string;
  tenantId?: string;
  chargeId: string | null;
  merchantAccountId: string | null;
  provider: string;
  providerDisputeId: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  status: DisputeStatus;
  providerStatus: string;
  reason: string | null;
  evidenceDueBy: Date | null;
  evidenceSubmitted: boolean;
  syncedAt: Date | null;
}

export interface PaymentMethodRow extends Timestamps {
  id: string;
  tenantId?: string;
  clientId: string;
  merchantAccountId: string | null;
  provider: string;
  providerMethodId: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  status: 'active' | 'removed';
}

export interface SubscriptionItemView {
  priceId: string;
  lookupKey: string | null;
  name: string;
  unitAmount: number | null;
  interval: BillingInterval;
  intervalCount: number;
  quantity: number;
  metered: boolean;
}

export interface PaymentSubscriptionRow extends Timestamps {
  id: string;
  tenantId?: string;
  /** `seller`: a seller's client subscribes; `platform`: a customer subscribes to your plan. */
  payee: 'seller' | 'platform';
  merchantAccountId: string | null;
  clientId: string | null;
  billingCustomerId: string | null;
  flow: ChargeFlow;
  provider: string;
  /** Provider subscription id; `pending:<id>` until checkout completes. */
  providerSubscriptionId: string;
  providerCheckoutId: string | null;
  requestId: string | null;
  plan: string | null;
  planPrice: string | null;
  status: SubscriptionStatus;
  currency: string;
  items: SubscriptionItemView[] | null;
  quantity: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  trialEnd: Date | null;
  applicationFeePercent: number | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: Date | null;
  latestInvoiceId: string | null;
  createdBy: string | null;
  metadata: Record<string, string> | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentInvoiceRow extends Timestamps {
  id: string;
  tenantId?: string;
  subscriptionId: string | null;
  merchantAccountId: string | null;
  billingCustomerId: string | null;
  provider: string;
  providerInvoiceId: string;
  status: InvoiceStatus;
  currency: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
  number: string | null;
  dueDate: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  billingReason: string | null;
  attemptCount: number;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentLinkRow extends Timestamps {
  id: string;
  tenantId?: string;
  merchantAccountId: string;
  provider: string;
  providerLinkId: string;
  flow: ChargeFlow;
  url: string | null;
  active: boolean;
  currency: string;
  items: Array<ChargeItem & { adjustableQuantity?: { minimum: number; maximum: number } }>;
  customAmount: boolean;
  platformFeeAmount: number;
  description: string;
  createdBy: string | null;
  metadata: Record<string, string> | null;
  livemode: boolean;
}

export interface PaymentTransferRow extends Timestamps {
  id: string;
  tenantId?: string;
  merchantAccountId: string;
  chargeId: string | null;
  provider: string;
  /** `pending:<id>` until the provider confirms. */
  providerTransferId: string;
  requestId: string | null;
  amount: number;
  currency: string;
  amountReversed: number;
  transferGroup: string | null;
  description: string | null;
  metadata: Record<string, string> | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentPayoutRow extends Timestamps {
  id: string;
  tenantId?: string;
  merchantAccountId: string;
  provider: string;
  providerPayoutId: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  method: 'standard' | 'instant';
  arrivalDate: Date | null;
  failureCode: string | null;
  livemode: boolean;
  syncedAt: Date | null;
}

export interface PaymentBillingCustomerRow extends Timestamps {
  id: string;
  tenantId: string;
  ownerType: BillingCustomerKind;
  ownerId: string;
  provider: string;
  providerCustomerId: string;
  email: string | null;
  livemode: boolean;
}

export interface PaymentEntitlementRow extends Timestamps {
  id: string;
  tenantId?: string;
  billingCustomerId: string;
  provider: string;
  feature: string;
  syncedAt: Date | null;
}

export type ProviderEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

export interface PaymentProviderEventRow extends Timestamps {
  id: string;
  tenantId: string | null;
  provider: string;
  providerEventId: string;
  type: string;
  format: 'snapshot' | 'thin';
  livemode: boolean;
  providerAccountId: string | null;
  merchantAccountId: string | null;
  objectId: string | null;
  objectType: string | null;
  status: ProviderEventStatus;
  ignoredReason: string | null;
  error: string | null;
  occurredAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
  payload: unknown;
}
