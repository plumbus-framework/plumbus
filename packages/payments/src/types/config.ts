// ── createPayments() configuration ──
// Every option here is documented in docs/payments/options.md. A test fails
// when an option is added without a section there.

import type { AccessPolicy } from '@plumbus/core';
import type {
  BillingInterval,
  ChargeCollection,
  ChargeFlow,
  ChargeType,
  CheckoutUi,
  MerchantDashboard,
  OnboardingMode,
  PaymentProvider,
  PayoutSchedule,
  Responsibility,
} from './provider.js';

/** Who owns a seller account: each signed-in user, or the whole tenant. */
export type SellerOwner = 'user' | 'tenant';

/** Who the platform bills for its own plans. */
export type BillingCustomerKind = 'tenant' | 'user' | 'seller';

/** Responsibilities for sellers who pick one dashboard. `true` = provider defaults. */
export type DashboardOption =
  | true
  | {
      /** Who pays the provider's processing fees on direct charges. */
      fees?: Responsibility;
      /** Who covers negative balances (refunds or disputes the seller can't pay). */
      losses?: Responsibility;
    };

export interface PlatformFeeRule {
  /** Percentage of the charge amount, 0–100. Rounded half-up to a whole minor unit. */
  percent?: number;
  /** Fixed amount per charge in minor units, keyed by lowercase ISO currency code. */
  fixed?: Record<string, number>;
}

export interface FeeMerchant {
  id: string;
  ownerType: SellerOwner;
  ownerId: string;
  dashboard: MerchantDashboard;
  feesCollector: Responsibility;
}

export interface PlatformFeeInput {
  amount: number;
  currency: string;
  /** How the client pays; `capture` recomputes the fee for the captured part of a hold. */
  kind: ChargeCollection | 'capture';
  flow: ChargeFlow;
  merchant: FeeMerchant;
}

/** Compute your cut in minor units. Use it for per-seller or per-currency pricing. */
export type PlatformFeeFunction = (input: PlatformFeeInput) => number | Promise<number>;

export interface SubscriptionFeeInput {
  currency: string;
  flow: ChargeFlow;
  merchant: FeeMerchant;
}

/** Your cut of each subscription payment, as a percentage (at most two decimals). */
export type SubscriptionFeeFunction = (input: SubscriptionFeeInput) => number | Promise<number>;

export interface PlanPriceConfig {
  /** Minor units per period (per seat when `perSeat`). */
  amount: number;
  currency: string;
  interval: BillingInterval;
  intervalCount?: number;
  /** Charge per seat; `setSeats` sets the quantity. */
  perSeat?: boolean;
}

export interface PlanConfig {
  name: string;
  description?: string;
  /** Entitlement feature keys this plan grants. */
  features?: string[];
  /** Prices by key, e.g. `{ monthly: {...}, yearly: {...} }`. */
  prices: Record<string, PlanPriceConfig>;
  /** Usage meters billed on this plan (keys of `billing.meters`). */
  meters?: string[];
  /** Free days before the first payment (overrides `billing.trialDays`). */
  trialDays?: number;
}

export interface MeterConfig {
  name: string;
  /** Event name usage is recorded under at the provider. */
  eventName: string;
  /** How usage in a period adds up. Default `sum`. */
  aggregation?: 'sum' | 'count' | 'last';
  /** Minor units per unit of usage; a decimal string allows fractions (e.g. `'0.05'`). */
  unitAmount: number | string;
  currency: string;
  /** Billing period of the usage price. Default `month`. */
  interval?: BillingInterval;
}

export interface BillingConfig {
  /** Who pays for the plans: the tenant, each user, or each seller account. */
  customer: BillingCustomerKind;
  plans: Record<string, PlanConfig>;
  meters?: Record<string, MeterConfig>;
  /** Display names of entitlement features (defaults to the key). */
  features?: Record<string, { name: string }>;
  /** Free days before the first payment, for every plan. */
  trialDays?: number;
  /** Let customers enter promotion codes at checkout. */
  allowPromotionCodes?: boolean;
  /** Calculate tax with the provider's tax engine. */
  automaticTax?: boolean;
  /** Prorate plan and seat changes (default true). */
  prorate?: boolean;
}

export interface PaymentsConfig {
  /** Payment provider adapter, e.g. `stripeProvider()` from @plumbus/payments-stripe. */
  provider: PaymentProvider;
  /** Sellers who charge their own clients. Omit for apps that only bill for themselves. */
  seller?: {
    /** `user`: every user can connect their own account. `tenant`: one account per tenant. */
    owner: SellerOwner;
  };
  access: {
    /** Who may connect an account, create charges, and read their charges. */
    sellers?: AccessPolicy;
    /** Who may refund. Defaults to `access.sellers`. */
    refunds?: AccessPolicy;
    /** Who may answer disputes. Defaults to `access.refunds`. */
    disputes?: AccessPolicy;
    /** Who may change the platform plan subscription. */
    billing?: AccessPolicy;
    /** Who may read plan entitlements. Defaults to any signed-in user of the tenant. */
    entitlements?: AccessPolicy;
  };
  /** Dashboards offered to sellers, with the responsibilities each one carries. */
  dashboards?: Partial<Record<MerchantDashboard, DashboardOption>>;
  /** Used when more than one dashboard is offered and the seller doesn't choose. */
  defaultDashboard?: MerchantDashboard;
  onboarding?: {
    /** Where sellers onboard: a provider-hosted page, components embedded in your app, or both. */
    modes?: OnboardingMode[];
    /** Collect only what is due now, or everything that will eventually be due. */
    collect?: 'currently_due' | 'eventually_due';
  };
  countries?: {
    /** ISO 3166-1 alpha-2 codes sellers may register in. Omit to allow any. */
    allowed?: string[];
    /** Country used when the seller doesn't choose one. */
    default?: string;
  };
  /** How sellers' charges move money, for all sellers or per dashboard. */
  chargeType?: ChargeType | Partial<Record<MerchantDashboard, ChargeType>>;
  destination?: {
    /** Make the seller the merchant of record on destination charges. */
    onBehalfOf?: boolean;
  };
  transfers?: {
    /** Platform charges and transfers to sellers (split payments, pay sellers later). */
    enabled?: boolean;
  };
  /** Lowercase ISO currency codes sellers may charge in. Omit to allow any. */
  currencies?: string[];
  /** Your cut of each charge. Omit for none. */
  platformFee?: PlatformFeeRule | PlatformFeeFunction;
  refunds?: {
    /** Return your platform fee to the seller on refunds (provider default: keep it). */
    refundPlatformFee?: boolean;
    /** Destination charges: take refunds back from the seller's transfer (default true). */
    reverseTransfer?: boolean;
  };
  checkout?: {
    /** How long a payment link stays valid, 30–1440 minutes (default 1440). */
    expiresAfterMinutes?: number;
    /** Payment page: provider-hosted, or embedded in your app. */
    ui?: CheckoutUi;
    locale?: string;
    allowPromotionCodes?: boolean;
    automaticTax?: boolean;
    billingAddress?: 'auto' | 'required';
    phone?: boolean;
    shippingCountries?: string[];
    submitType?: 'auto' | 'pay' | 'book' | 'donate';
  };
  invoices?: {
    /** Days the client has to pay an invoice (default 30). */
    daysUntilDue?: number;
  };
  subscriptions?: {
    /** Sellers can sell subscriptions to their clients. */
    enabled?: boolean;
    /** Your cut of each subscription payment as a percentage; defaults to `platformFee.percent`. */
    platformFeePercent?: number | SubscriptionFeeFunction;
  };
  payouts?: {
    /** Payout schedule set for new sellers (sellers on Express or no dashboard). */
    schedule?: PayoutSchedule;
    /** Let sellers change their own payout schedule. */
    sellersMayChangeSchedule?: boolean;
    /** Let sellers request instant payouts. */
    instant?: boolean;
  };
  embedded?: {
    /** Let sellers refund from embedded payment components. */
    allowRefunds?: boolean;
    /** Let sellers respond to disputes from embedded components. */
    allowDisputeManagement?: boolean;
  };
  /** Plans the platform bills its own customers for. */
  billing?: BillingConfig;
  urls: {
    /** Where the provider sends a seller after onboarding. */
    onboardingReturn?: string;
    /** Where the provider sends a seller whose onboarding link expired; mint a new link there. */
    onboardingRefresh?: string;
    /** Where the client lands after paying. `{chargeId}` is replaced with the charge id. */
    checkoutSuccess?: string;
    /** Where the client lands if they leave checkout. `{chargeId}` is replaced too. */
    checkoutCancel?: string;
    /** Embedded payment pages: where the client lands after paying (`{chargeId}`). */
    checkoutReturn?: string;
    /** Where the client lands after saving a payment method (`{clientId}`). */
    setupSuccess?: string;
    /** Where the client lands if they leave saving a payment method. */
    setupCancel?: string;
    /** Where the client portal sends the client back to. */
    portalReturn?: string;
    /** Where a customer lands after subscribing to a plan. */
    billingSuccess?: string;
    /** Where a customer lands if they leave plan checkout. */
    billingCancel?: string;
    /** Where the billing portal sends the customer back to. */
    billingPortalReturn?: string;
    /** Where a client lands after paying through a payment link. */
    linkCompleted?: string;
  };
  webhooks?: {
    /** Route path. Default `/payments/webhooks/<provider id>`. */
    path?: string;
    /** Maximum webhook body size in bytes (default 1 MiB). */
    bodyLimitBytes?: number;
    /** Keep each event's full body in the ledger. Off by default (bodies carry personal data). */
    storePayload?: boolean;
  };
  /** Stamped into provider metadata so several apps can share one provider account. */
  appId?: string;
}

type DashboardResponsibilities = { fees: Responsibility; losses: Responsibility };

/** Config after defaults are applied. Providers validate against this shape. */
export interface NormalizedPaymentsConfig {
  seller: { owner: SellerOwner } | null;
  access: {
    sellers: AccessPolicy;
    refunds: AccessPolicy;
    disputes: AccessPolicy;
    billing: AccessPolicy;
    entitlements: AccessPolicy;
  };
  dashboards: Partial<Record<MerchantDashboard, DashboardResponsibilities>>;
  defaultDashboard: MerchantDashboard | null;
  onboarding: { modes: OnboardingMode[]; collect: 'currently_due' | 'eventually_due' };
  countries: { allowed: string[] | null; default: string | null };
  /** Charge type per offered dashboard. */
  chargeType: Partial<Record<MerchantDashboard, ChargeType>>;
  destination: { onBehalfOf: boolean };
  transfers: { enabled: boolean };
  currencies: string[] | null;
  platformFee: PlatformFeeRule | PlatformFeeFunction | null;
  refunds: { refundPlatformFee: boolean; reverseTransfer: boolean };
  checkout: {
    expiresAfterMinutes: number;
    ui: CheckoutUi;
    locale: string | null;
    allowPromotionCodes: boolean;
    automaticTax: boolean;
    billingAddress: 'auto' | 'required' | null;
    phone: boolean;
    shippingCountries: string[] | null;
    submitType: 'auto' | 'pay' | 'book' | 'donate' | null;
  };
  invoices: { daysUntilDue: number };
  subscriptions: {
    enabled: boolean;
    platformFeePercent: number | SubscriptionFeeFunction;
  };
  payouts: {
    schedule: PayoutSchedule | null;
    sellersMayChangeSchedule: boolean;
    instant: boolean;
  };
  embedded: { allowRefunds: boolean; allowDisputeManagement: boolean };
  billing: {
    customer: BillingCustomerKind;
    plans: Record<string, PlanConfig>;
    meters: Record<string, MeterConfig>;
    features: Record<string, { name: string }>;
    trialDays: number | null;
    allowPromotionCodes: boolean;
    automaticTax: boolean;
    prorate: boolean;
  } | null;
  urls: {
    onboardingReturn: string | null;
    onboardingRefresh: string | null;
    checkoutSuccess: string | null;
    checkoutCancel: string | null;
    checkoutReturn: string | null;
    setupSuccess: string | null;
    setupCancel: string | null;
    portalReturn: string | null;
    billingSuccess: string | null;
    billingCancel: string | null;
    billingPortalReturn: string | null;
    linkCompleted: string | null;
  };
  webhooks: { path: string; bodyLimitBytes: number; storePayload: boolean };
  appId: string | null;
}
