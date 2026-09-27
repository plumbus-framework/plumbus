// ── Payment provider contract ──
// Every vendor adapter (for example @plumbus/payments-stripe) implements this
// interface. The neutral package only talks to providers through it, so vendor
// objects never leak into entities, events, or capability outputs.
// Methods marked optional back optional features; createPayments() refuses a
// config that enables a feature its provider does not implement.

/** Which hosted dashboard the provider gives a seller. */
export const MerchantDashboard = {
  Full: 'full',
  Express: 'express',
  None: 'none',
} as const;
export type MerchantDashboard = (typeof MerchantDashboard)[keyof typeof MerchantDashboard];

/** Who carries a responsibility: the payment provider itself, or the platform (your app). */
export const Responsibility = {
  Provider: 'provider',
  Platform: 'platform',
} as const;
export type Responsibility = (typeof Responsibility)[keyof typeof Responsibility];

/** How a seller's charges move money. */
export const ChargeType = {
  /** On the seller's own account; the seller is the merchant of record. */
  Direct: 'direct',
  /** On the platform, paid on to the seller at once; the platform is the merchant of record. */
  Destination: 'destination',
} as const;
export type ChargeType = (typeof ChargeType)[keyof typeof ChargeType];

/** Where a charge lives: a seller's charge type, or `platform` (the app keeps it or transfers later). */
export const ChargeFlow = {
  Direct: 'direct',
  Destination: 'destination',
  Platform: 'platform',
} as const;
export type ChargeFlow = (typeof ChargeFlow)[keyof typeof ChargeFlow];

/** How the client is asked to pay. */
export const ChargeCollection = {
  /** A provider-hosted or embedded payment page. */
  Checkout: 'checkout',
  /** An invoice the provider emails, with its own payment page. */
  Invoice: 'invoice',
  /** A payment method the client saved earlier, charged without them. */
  SavedMethod: 'saved_method',
  /** A reusable payment link; each payment becomes a charge. */
  Link: 'link',
} as const;
export type ChargeCollection = (typeof ChargeCollection)[keyof typeof ChargeCollection];

/** Where sellers complete onboarding. */
export const OnboardingMode = {
  Hosted: 'hosted',
  Embedded: 'embedded',
} as const;
export type OnboardingMode = (typeof OnboardingMode)[keyof typeof OnboardingMode];

/** Seller-facing embeddable components a merchant session can unlock. */
export const MerchantComponent = {
  Onboarding: 'onboarding',
  Account: 'account',
  Notifications: 'notifications',
  Payments: 'payments',
  Payouts: 'payouts',
  Balances: 'balances',
  Disputes: 'disputes',
  Documents: 'documents',
} as const;
export type MerchantComponent = (typeof MerchantComponent)[keyof typeof MerchantComponent];

/** Neutral lifecycle of a charge (one request for money from one client). */
export const ChargeStatus = {
  Open: 'open',
  /** A saved payment method needs the client (authentication, new card); `url` lets them pay. */
  RequiresAction: 'requires_action',
  Processing: 'processing',
  /** Held on the client's payment method; capture or cancel it. */
  Authorized: 'authorized',
  Paid: 'paid',
  Failed: 'failed',
  Expired: 'expired',
  Canceled: 'canceled',
} as const;
export type ChargeStatus = (typeof ChargeStatus)[keyof typeof ChargeStatus];

export const RefundStatus = {
  Pending: 'pending',
  RequiresAction: 'requires_action',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Canceled: 'canceled',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

export const DisputeStatus = {
  NeedsResponse: 'needs_response',
  UnderReview: 'under_review',
  Won: 'won',
  Lost: 'lost',
  Closed: 'closed',
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

export const SubscriptionStatus = {
  Incomplete: 'incomplete',
  IncompleteExpired: 'incomplete_expired',
  Trialing: 'trialing',
  Active: 'active',
  PastDue: 'past_due',
  Unpaid: 'unpaid',
  Paused: 'paused',
  Canceled: 'canceled',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const InvoiceStatus = {
  Draft: 'draft',
  Open: 'open',
  Paid: 'paid',
  Void: 'void',
  Uncollectible: 'uncollectible',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const PayoutStatus = {
  Pending: 'pending',
  InTransit: 'in_transit',
  Paid: 'paid',
  Failed: 'failed',
  Canceled: 'canceled',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export type CheckoutUi = 'hosted' | 'embedded';
export type CaptureMode = 'automatic' | 'manual';
export type BillingInterval = 'day' | 'week' | 'month' | 'year';

/** Seller account state as the provider reports it. */
export interface ProviderMerchantAccount {
  id: string;
  dashboard: MerchantDashboard;
  feesCollector: Responsibility;
  lossesCollector: Responsibility;
  country: string | null;
  defaultCurrency: string | null;
  /** The seller can accept card payments on their own account (direct charges). */
  chargesEnabled: boolean;
  /** The seller can receive transfers from the platform (destination charges, transfers). */
  transfersEnabled: boolean;
  payoutsEnabled: boolean;
  /** Human-readable requirements the seller must still provide now. */
  requirementsDue: string[];
  /** Requirements whose deadline has passed (the account is or will be restricted). */
  requirementsPastDue: string[];
  /** Provider reason when payments are switched off, if any. */
  disabledReason: string | null;
  closed: boolean;
  livemode: boolean;
}

/** A saved payment method, shown to sellers without card numbers. */
export interface ProviderPaymentMethod {
  id: string;
  customerId: string | null;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * A charge as the provider reports it. `id` is the provider object for the
 * payment attempt (a checkout page, an invoice, or a payment); `reference` is the
 * local PaymentCharge id. Amounts that a read does not include are null (the
 * stored values are kept).
 */
export interface ProviderCharge {
  id: string;
  reference: string | null;
  paymentId: string | null;
  /** Payment link the charge came from, for payments through a link. */
  linkId: string | null;
  status: ChargeStatus;
  currency: string;
  /** Items before discounts and tax. */
  amountSubtotal: number | null;
  /** What the client pays: subtotal − discounts + tax. */
  amountTotal: number | null;
  amountDiscount: number | null;
  amountTax: number | null;
  platformFeeAmount: number | null;
  /** Refunded so far, pending refunds included or not. */
  amountRefunded: number | null;
  /** Held and not yet captured. */
  amountCapturable: number | null;
  /** When a hold lapses if not captured. */
  captureBefore: Date | null;
  url: string | null;
  /** Secret for an embedded payment page. */
  clientSecret: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  clientEmail: string | null;
  customerId: string | null;
  /** The payment method used, when the provider saved it for later use. */
  savedMethod: ProviderPaymentMethod | null;
  failureCode: string | null;
  livemode: boolean;
}

export interface ProviderRefund {
  id: string;
  /** Local PaymentRefund id when the refund was created through Plumbus. */
  reference: string | null;
  paymentId: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  failureReason: string | null;
}

export interface ProviderDispute {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: DisputeStatus;
  providerStatus: string;
  reason: string | null;
  evidenceDueBy: Date | null;
  /** Evidence was submitted; the provider no longer accepts changes. */
  evidenceSubmitted: boolean;
}

export interface ProviderSubscriptionItem {
  id: string;
  priceId: string;
  /** The catalog key of the price, for plans from `billing.plans`. */
  lookupKey: string | null;
  name: string;
  unitAmount: number | null;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  quantity: number;
  metered: boolean;
}

export interface ProviderSubscription {
  id: string;
  /** Local PaymentSubscription id. */
  reference: string | null;
  customerId: string;
  status: SubscriptionStatus;
  currency: string;
  items: ProviderSubscriptionItem[];
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  trialEnd: Date | null;
  latestInvoiceId: string | null;
  applicationFeePercent: number | null;
  livemode: boolean;
}

export interface ProviderInvoice {
  id: string;
  /** Local PaymentCharge id for invoices sent as a charge. */
  reference: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  status: InvoiceStatus;
  currency: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
  number: string | null;
  dueDate: Date | null;
  paymentId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  billingReason: string | null;
  /** Collection attempts so far; a rise without payment is a failed attempt. */
  attemptCount: number;
  livemode: boolean;
}

export interface ProviderTransfer {
  id: string;
  /** Local PaymentTransfer id. */
  reference: string | null;
  destinationAccountId: string;
  amount: number;
  currency: string;
  amountReversed: number;
  transferGroup: string | null;
  sourcePaymentId: string | null;
  livemode: boolean;
}

export interface ProviderPayout {
  id: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  method: 'standard' | 'instant';
  arrivalDate: Date | null;
  failureCode: string | null;
  livemode: boolean;
}

export interface PayoutSchedule {
  interval: 'manual' | 'daily' | 'weekly' | 'monthly';
  /** Days funds wait before a payout (at most 31); `minimum` = the shortest the provider allows. */
  delayDays?: number | 'minimum';
  /** Weekly payouts: the weekday. Payouts are not sent on weekends. */
  weeklyAnchor?: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
  monthlyAnchor?: number;
}

export interface PayoutSettings {
  schedule: PayoutSchedule;
  instantAvailable: boolean;
}

export interface ProviderPaymentLink {
  id: string;
  url: string;
  active: boolean;
}

/** One state change the worker applies after re-reading the provider. */
export type ProviderStateChange =
  | { kind: 'merchant'; account: ProviderMerchantAccount }
  | {
      kind: 'charge';
      /** Seller account the object lives on (direct charges), or null for the platform. */
      accountId: string | null;
      charge: ProviderCharge;
    }
  | {
      kind: 'refund';
      accountId: string | null;
      chargeReference: string | null;
      refund: ProviderRefund;
    }
  | {
      kind: 'dispute';
      accountId: string | null;
      chargeReference: string | null;
      dispute: ProviderDispute;
    }
  | {
      kind: 'payment_method';
      accountId: string | null;
      method: ProviderPaymentMethod;
      detached: boolean;
    }
  | { kind: 'subscription'; accountId: string | null; subscription: ProviderSubscription }
  | {
      /** A subscription's checkout page expired before the first payment. */
      kind: 'subscription_checkout_expired';
      accountId: string | null;
      checkoutId: string;
      reference: string | null;
    }
  | { kind: 'invoice'; accountId: string | null; invoice: ProviderInvoice }
  | { kind: 'transfer'; transfer: ProviderTransfer }
  | { kind: 'payout'; accountId: string; payout: ProviderPayout }
  | { kind: 'entitlements'; customerId: string; features: string[] };

/** Hints for finding the tenant of an event that no seller account carries. */
export interface ProviderEventRouting {
  /** Tenant stamped into the object's metadata by this package. */
  tenantId: string | null;
  customerId: string | null;
  paymentId: string | null;
  subscriptionId: string | null;
}

/** A webhook delivery whose signature the provider has verified. */
export interface VerifiedProviderEvent {
  eventId: string;
  type: string;
  /** `snapshot` events carry the object; `thin` events carry only its id. */
  format: 'snapshot' | 'thin';
  livemode: boolean;
  occurredAt: Date;
  /** Seller account the event concerns, or null for platform-level events. */
  accountId: string | null;
  objectId: string | null;
  objectType: string | null;
  /** How to find the tenant of a platform-level event. */
  routing: ProviderEventRouting;
  /** Raw decoded body, persisted only when `webhooks.storePayload` is on. */
  payload: unknown;
}

/** The stored form of a received event, handed back to `resolveEvent` by the worker. */
export interface StoredProviderEvent {
  eventId: string;
  type: string;
  format: 'snapshot' | 'thin';
  livemode: boolean;
  accountId: string | null;
  objectId: string | null;
  objectType: string | null;
}

export interface CreateMerchantAccountInput {
  dashboard: MerchantDashboard;
  feesCollector: Responsibility;
  lossesCollector: Responsibility;
  country: string;
  email?: string;
  displayName?: string;
  defaultCurrency?: string;
  /** What the seller must be able to do: accept payments themselves, receive transfers, or both. */
  capabilities: { cardPayments: boolean; transfers: boolean };
  metadata: Record<string, string>;
  idempotencyKey: string;
}

/** Where a charge is created and who is paid. */
export interface ChargeRouting {
  flow: ChargeFlow;
  /** The seller: where a direct charge lives, or where a destination charge is paid to. */
  sellerAccountId: string | null;
  /** Destination charges: make the seller the merchant of record (their statement descriptor). */
  onBehalfOf: boolean;
  /** Platform charges: group them for transfers to sellers later. */
  transferGroup: string | null;
}

export interface ChargeItem {
  name: string;
  description?: string;
  /** Minor units per unit. */
  unitAmount: number;
  quantity: number;
}

/** Checkout page options. Unset options keep the provider's defaults. */
export interface CheckoutOptions {
  allowPromotionCodes?: boolean;
  automaticTax?: boolean;
  billingAddress?: 'auto' | 'required';
  phone?: boolean;
  /** ISO country codes to ship to; collects a shipping address when set. */
  shippingCountries?: string[];
  locale?: string;
  submitType?: 'auto' | 'pay' | 'book' | 'donate';
  statementDescriptorSuffix?: string;
}

/** The client chooses the amount (tips, donations). One item only. */
export interface CustomAmount {
  minimum?: number;
  maximum?: number;
  preset?: number;
}

export interface CreateChargeInput extends ChargeRouting {
  reference: string;
  currency: string;
  items: ChargeItem[];
  customAmount?: CustomAmount;
  /** Shown on receipts and statements. */
  description: string;
  platformFeeAmount: number;
  clientId?: string;
  clientEmail?: string;
  ui: CheckoutUi;
  /** Hosted pages: where the client lands after paying or leaving. */
  successUrl: string;
  cancelUrl: string;
  /** Embedded pages: where the client lands after paying. */
  returnUrl: string;
  expiresAt: Date;
  capture: CaptureMode;
  /** Keep the payment method on the client for later charges without them. */
  saveMethod: boolean;
  options: CheckoutOptions;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateInvoiceChargeInput extends ChargeRouting {
  reference: string;
  currency: string;
  items: ChargeItem[];
  description: string;
  platformFeeAmount: number;
  clientId: string;
  dueInDays: number;
  automaticTax: boolean;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface ChargeSavedMethodInput extends ChargeRouting {
  reference: string;
  amount: number;
  currency: string;
  description: string;
  platformFeeAmount: number;
  clientId: string;
  methodId: string;
  capture: CaptureMode;
  statementDescriptorSuffix?: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateRefundInput {
  routing: ChargeRouting;
  paymentId: string;
  reference: string;
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  refundPlatformFee: boolean;
  /** Destination charges: take the refund back from the seller's transfer. */
  reverseTransfer: boolean;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateClientInput {
  /** Seller account to create the customer on, or null for the platform. */
  sellerAccountId: string | null;
  email?: string;
  name?: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface MerchantSession {
  clientSecret: string;
  expiresAt: Date;
  publishableKey: string | null;
}

export interface SubscriptionItemInput {
  /** An existing price, a catalog price by lookup key (billing plans), or an inline price. */
  priceId?: string;
  lookupKey?: string;
  inline?: { name: string; unitAmount: number; interval: BillingInterval; intervalCount: number };
  /** Omitted for metered prices. */
  quantity?: number;
}

export interface CreateSubscriptionCheckoutInput extends ChargeRouting {
  reference: string;
  clientId: string;
  currency: string;
  items: SubscriptionItemInput[];
  trialDays?: number;
  applicationFeePercent?: number;
  ui: CheckoutUi;
  successUrl: string;
  cancelUrl: string;
  returnUrl: string;
  expiresAt: Date;
  options: CheckoutOptions;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CheckoutPage {
  id: string;
  url: string | null;
  clientSecret: string | null;
  expiresAt: Date | null;
}

export interface UpdateSubscriptionInput {
  sellerAccountId: string | null;
  subscriptionId: string;
  /** Replace, change, or add items. `itemId` targets an existing item. */
  items?: Array<{
    itemId?: string;
    priceId?: string;
    lookupKey?: string;
    quantity?: number;
    deleted?: boolean;
  }>;
  cancelAtPeriodEnd?: boolean;
  prorate: boolean;
  idempotencyKey: string;
}

export interface CreatePaymentLinkInput extends ChargeRouting {
  reference: string;
  currency: string;
  items: Array<ChargeItem & { adjustableQuantity?: { minimum: number; maximum: number } }>;
  customAmount?: CustomAmount;
  platformFeeAmount: number;
  options: CheckoutOptions;
  /** Where the client lands after paying. */
  completedUrl: string | null;
  metadata: Record<string, string>;
}

export interface CreateTransferInput {
  destinationAccountId: string;
  amount: number;
  currency: string;
  transferGroup: string | null;
  /** Tie the transfer to a payment so it waits for that payment's funds. */
  sourcePaymentId: string | null;
  reference: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

/** Evidence a seller submits for a dispute. Text fields; files are uploaded in provider UIs. */
export interface DisputeEvidence {
  productDescription?: string;
  customerName?: string;
  customerEmail?: string;
  serviceDate?: string;
  refundPolicy?: string;
  cancellationPolicy?: string;
  uncategorizedText?: string;
}

/** The platform's billing catalog, derived from `billing.plans` and `billing.meters`. */
export interface CatalogInput {
  /** Namespace for lookup keys, so apps can share a provider account. */
  namespace: string;
  plans: Array<{
    key: string;
    name: string;
    description?: string;
    features: string[];
    prices: Array<{
      key: string;
      lookupKey: string;
      amount: number;
      currency: string;
      interval: BillingInterval;
      intervalCount: number;
      perSeat: boolean;
    }>;
  }>;
  meters: Array<{
    key: string;
    lookupKey: string;
    name: string;
    eventName: string;
    aggregation: 'sum' | 'count' | 'last';
    /** Minor units per unit of usage, as a decimal string (fractions allowed). */
    unitAmountDecimal: string;
    currency: string;
    interval: BillingInterval;
  }>;
  features: Array<{ key: string; name: string }>;
}

export interface CatalogResult {
  /** Provider price id per catalog lookup key. */
  prices: Record<string, string>;
  /** What was created or changed (sync) or is missing/out of date (check). */
  changes: string[];
}

/** A config or environment problem found by validation or `plumbus payments doctor`. */
export interface PaymentsFinding {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  /** Config path the finding is about, e.g. `dashboards.express`. */
  path?: string;
}

export interface WebhookSetupResult {
  destinations: Array<{
    id: string;
    name: string;
    format: 'snapshot' | 'thin';
    url: string;
    /** Signing secret, returned once at creation. Store it in your secret manager. */
    secret: string | null;
    created: boolean;
  }>;
}

export interface PaymentProvider {
  /** Stable provider id used in routes, ledger rows, and entity `provider` columns. */
  readonly id: string;
  readonly displayName: string;
  /** Public key the front end needs for embedded payment pages and components. */
  readonly publishableKey?: string | null;
  /** Responsibilities used when the app offers a dashboard with `true`. */
  defaultResponsibilities(dashboard: MerchantDashboard): {
    fees: Responsibility;
    losses: Responsibility;
  };
  /** Static checks of the app's payments config against this provider's rules. */
  validateConfig(config: import('./config.js').NormalizedPaymentsConfig): PaymentsFinding[];
  /** `true` when the configured credentials are live, `false` in test mode. */
  resolveLivemode(): Promise<boolean>;
  /** Cheap pre-filter at ingest: `false` records the event as ignored without queuing work. */
  isRelevantEvent(event: VerifiedProviderEvent): boolean;

  // Sellers
  createMerchantAccount(input: CreateMerchantAccountInput): Promise<ProviderMerchantAccount>;
  retrieveMerchantAccount(accountId: string): Promise<ProviderMerchantAccount>;
  createOnboardingLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
    collectEventuallyDue: boolean;
  }): Promise<{ url: string; expiresAt: Date }>;
  createMerchantSession(input: {
    accountId: string;
    components: readonly MerchantComponent[];
    allowRefunds: boolean;
    allowDisputeManagement: boolean;
  }): Promise<MerchantSession>;
  createDashboardLink(input: {
    accountId: string;
    dashboard: MerchantDashboard;
  }): Promise<{ url: string }>;

  // Charges
  createClient(input: CreateClientInput): Promise<{ clientId: string }>;
  createCharge(input: CreateChargeInput): Promise<ProviderCharge>;
  createRefund(input: CreateRefundInput): Promise<ProviderRefund>;
  /**
   * Find a refund by the local id it was created with (`reference`), or null. Used
   * to settle a refund whose creation outcome was lost (a crash mid-call); without
   * it such a refund stays pending locally.
   */
  findRefund?(input: {
    routing: ChargeRouting;
    paymentId: string;
    reference: string;
  }): Promise<ProviderRefund | null>;
  createInvoiceCharge?(input: CreateInvoiceChargeInput): Promise<ProviderCharge>;
  captureCharge?(input: {
    routing: ChargeRouting;
    paymentId: string;
    amount?: number;
    platformFeeAmount?: number;
    idempotencyKey: string;
  }): Promise<ProviderCharge>;
  /** Stop a charge: expire its payment page, void its invoice, or release its hold. */
  cancelCharge?(input: {
    routing: ChargeRouting;
    collection: ChargeCollection;
    chargeId: string;
    paymentId: string | null;
  }): Promise<ProviderCharge>;

  // Saved payment methods and the client portal
  createSetupSession?(input: {
    sellerAccountId: string | null;
    clientId: string;
    reference: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<CheckoutPage>;
  listPaymentMethods?(input: {
    sellerAccountId: string | null;
    clientId: string;
  }): Promise<ProviderPaymentMethod[]>;
  detachPaymentMethod?(input: { sellerAccountId: string | null; methodId: string }): Promise<void>;
  chargeSavedMethod?(input: ChargeSavedMethodInput): Promise<ProviderCharge>;
  createPortalSession?(input: {
    sellerAccountId: string | null;
    clientId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  // Subscriptions (sellers' clients and the platform's own plans)
  createSubscriptionCheckout?(input: CreateSubscriptionCheckoutInput): Promise<CheckoutPage>;
  retrieveSubscription?(input: {
    sellerAccountId: string | null;
    subscriptionId: string;
  }): Promise<ProviderSubscription>;
  updateSubscription?(input: UpdateSubscriptionInput): Promise<ProviderSubscription>;
  cancelSubscription?(input: {
    sellerAccountId: string | null;
    subscriptionId: string;
    atPeriodEnd: boolean;
    idempotencyKey: string;
  }): Promise<ProviderSubscription>;

  // Payment links
  createPaymentLink?(input: CreatePaymentLinkInput): Promise<ProviderPaymentLink>;
  updatePaymentLink?(input: {
    sellerAccountId: string | null;
    linkId: string;
    active: boolean;
  }): Promise<ProviderPaymentLink>;

  // Transfers to sellers (platform charges)
  createTransfer?(input: CreateTransferInput): Promise<ProviderTransfer>;
  reverseTransfer?(input: {
    transferId: string;
    amount?: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ProviderTransfer>;

  // Payouts
  retrievePayoutSettings?(input: { accountId: string }): Promise<PayoutSettings>;
  updatePayoutSchedule?(input: {
    accountId: string;
    schedule: PayoutSchedule;
  }): Promise<PayoutSettings>;
  listPayouts?(input: { accountId: string; limit: number }): Promise<ProviderPayout[]>;
  createPayout?(input: {
    accountId: string;
    amount: number;
    currency: string;
    method: 'standard' | 'instant';
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ProviderPayout>;

  // Disputes
  updateDispute?(input: {
    sellerAccountId: string | null;
    disputeId: string;
    evidence: DisputeEvidence;
    submit: boolean;
  }): Promise<ProviderDispute>;
  acceptDispute?(input: {
    sellerAccountId: string | null;
    disputeId: string;
  }): Promise<ProviderDispute>;

  // The platform's own billing
  createBillingCustomer?(input: {
    email?: string;
    name?: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ customerId: string }>;
  /** Create or update the catalog so it matches `input`. */
  syncCatalog?(input: CatalogInput): Promise<CatalogResult>;
  /** Read-only: resolve catalog prices; `changes` lists what `syncCatalog` would do. */
  checkCatalog?(input: CatalogInput): Promise<CatalogResult>;
  listEntitlements?(input: { customerId: string }): Promise<string[]>;
  recordUsage?(input: {
    customerId: string;
    eventName: string;
    value: number;
    identifier: string;
    timestamp: Date;
  }): Promise<void>;

  /** Verify a webhook delivery. Throw on any signature or parse failure. */
  verifyWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<VerifiedProviderEvent>;
  /**
   * Re-read the provider for the objects an event concerns. Empty = nothing to
   * apply. List a charge before its refunds and disputes: they are matched to the
   * local charge by the payment id the charge change records.
   */
  resolveEvent(event: StoredProviderEvent): Promise<ProviderStateChange[]>;

  /** Live environment checks for `plumbus payments doctor --live`. */
  diagnose?(input: { webhookUrl?: string; catalog?: CatalogInput }): Promise<PaymentsFinding[]>;
  /** Create the webhook destinations this provider needs, for `plumbus payments webhooks setup`. */
  setupWebhooks?(input: { url: string }): Promise<WebhookSetupResult>;
}
