// ── Payment provider contract ──
// Every vendor adapter (for example @plumbus/payments-stripe) implements this
// interface. The neutral package only talks to providers through it, so vendor
// objects never leak into entities, events, or capability outputs.

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

/** How money moves for a charge. Only `direct` ships in 0.2.0. */
export const ChargeType = {
  Direct: 'direct',
  Destination: 'destination',
  Separate: 'separate',
} as const;
export type ChargeType = (typeof ChargeType)[keyof typeof ChargeType];

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
  Processing: 'processing',
  Paid: 'paid',
  Failed: 'failed',
  Expired: 'expired',
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

/** Seller account state as the provider reports it. */
export interface ProviderMerchantAccount {
  id: string;
  dashboard: MerchantDashboard;
  feesCollector: Responsibility;
  lossesCollector: Responsibility;
  country: string | null;
  defaultCurrency: string | null;
  chargesEnabled: boolean;
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

/** A charge as the provider reports it. `reference` is the local PaymentCharge id. */
export interface ProviderCharge {
  id: string;
  reference: string | null;
  paymentId: string | null;
  status: ChargeStatus;
  amount: number;
  currency: string;
  /** Null when the provider's read does not include it yet (the stored value is kept). */
  platformFeeAmount: number | null;
  /** Refunded so far, pending refunds included or not; null when the read does not say. */
  amountRefunded: number | null;
  url: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  clientEmail: string | null;
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
}

/** One state change the worker applies after re-reading the provider. */
export type ProviderStateChange =
  | { kind: 'merchant'; account: ProviderMerchantAccount }
  | { kind: 'charge'; accountId: string; charge: ProviderCharge }
  | { kind: 'refund'; accountId: string; chargeReference: string | null; refund: ProviderRefund }
  | {
      kind: 'dispute';
      accountId: string;
      chargeReference: string | null;
      dispute: ProviderDispute;
    };

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
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateChargeInput {
  accountId: string;
  reference: string;
  amount: number;
  currency: string;
  description: string;
  platformFeeAmount: number;
  clientId?: string;
  clientEmail?: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateRefundInput {
  accountId: string;
  paymentId: string;
  reference: string;
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  refundPlatformFee: boolean;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateClientInput {
  accountId: string;
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

  createClient(input: CreateClientInput): Promise<{ clientId: string }>;
  createCharge(input: CreateChargeInput): Promise<ProviderCharge>;
  createRefund(input: CreateRefundInput): Promise<ProviderRefund>;

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
  diagnose?(input: { webhookUrl?: string }): Promise<PaymentsFinding[]>;
  /** Create the webhook destinations this provider needs, for `plumbus payments webhooks setup`. */
  setupWebhooks?(input: { url: string }): Promise<WebhookSetupResult>;
}
