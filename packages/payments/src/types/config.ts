// ── createPayments() configuration ──
// Every option here is documented in docs/payments/options.md. A test fails
// when an option is added without a section there.

import type { AccessPolicy } from '@plumbus/core';
import type {
  ChargeType,
  MerchantDashboard,
  OnboardingMode,
  PaymentProvider,
  Responsibility,
} from './provider.js';

/** Who owns a seller account: each signed-in user, or the whole tenant. */
export type SellerOwner = 'user' | 'tenant';

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

export interface PlatformFeeInput {
  amount: number;
  currency: string;
  merchant: {
    id: string;
    ownerType: SellerOwner;
    ownerId: string;
    dashboard: MerchantDashboard;
    feesCollector: Responsibility;
  };
}

/** Compute your cut in minor units. Use it for per-seller or per-currency pricing. */
export type PlatformFeeFunction = (input: PlatformFeeInput) => number | Promise<number>;

export interface PaymentsConfig {
  /** Payment provider adapter, e.g. `stripeProvider()` from @plumbus/payments-stripe. */
  provider: PaymentProvider;
  seller: {
    /** `user`: every user can connect their own account. `tenant`: one account per tenant. */
    owner: SellerOwner;
  };
  access: {
    /** Who may connect an account, create charges, and read their charges. */
    sellers: AccessPolicy;
    /** Who may refund. Defaults to `access.sellers`. */
    refunds?: AccessPolicy;
  };
  /** Dashboards offered to sellers, with the responsibilities each one carries. */
  dashboards: Partial<Record<MerchantDashboard, DashboardOption>>;
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
  /** How money moves. Only `direct` is available in this release. */
  chargeType?: ChargeType;
  /** Lowercase ISO currency codes sellers may charge in. Omit to allow any. */
  currencies?: string[];
  /** Your cut of each charge. Omit for none. */
  platformFee?: PlatformFeeRule | PlatformFeeFunction;
  refunds?: {
    /** Return your platform fee to the seller on refunds (provider default: keep it). */
    refundPlatformFee?: boolean;
  };
  checkout?: {
    /** How long a payment link stays valid, 30–1440 minutes (default 1440). */
    expiresAfterMinutes?: number;
  };
  embedded?: {
    /** Let sellers refund from embedded payment components. */
    allowRefunds?: boolean;
    /** Let sellers respond to disputes from embedded components. */
    allowDisputeManagement?: boolean;
  };
  urls: {
    /** Where the provider sends a seller after onboarding. */
    onboardingReturn: string;
    /** Where the provider sends a seller whose onboarding link expired; mint a new link there. */
    onboardingRefresh: string;
    /** Where the client lands after paying. `{chargeId}` is replaced with the charge id. */
    checkoutSuccess: string;
    /** Where the client lands if they leave checkout. `{chargeId}` is replaced too. */
    checkoutCancel: string;
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

/** Config after defaults are applied. Providers validate against this shape. */
export interface NormalizedPaymentsConfig {
  seller: { owner: SellerOwner };
  access: { sellers: AccessPolicy; refunds: AccessPolicy };
  dashboards: Partial<Record<MerchantDashboard, { fees: Responsibility; losses: Responsibility }>>;
  defaultDashboard: MerchantDashboard | null;
  onboarding: { modes: OnboardingMode[]; collect: 'currently_due' | 'eventually_due' };
  countries: { allowed: string[] | null; default: string | null };
  chargeType: ChargeType;
  currencies: string[] | null;
  platformFee: PlatformFeeRule | PlatformFeeFunction | null;
  refunds: { refundPlatformFee: boolean };
  checkout: { expiresAfterMinutes: number };
  embedded: { allowRefunds: boolean; allowDisputeManagement: boolean };
  urls: {
    onboardingReturn: string;
    onboardingRefresh: string;
    checkoutSuccess: string;
    checkoutCancel: string;
  };
  webhooks: { path: string; bodyLimitBytes: number; storePayload: boolean };
  appId: string | null;
}
