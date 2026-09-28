// ── Config normalization + rule checks ──
// Hard rules (combinations the provider would reject, missing settings a feature
// needs, features the provider does not implement) throw at startup. Advice is
// returned as warnings, matching Plumbus's advisory governance: the app
// decides, the framework explains.

import type { AccessPolicy } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { NormalizedPaymentsConfig, PaymentsConfig } from '../types/config.js';
import type {
  ChargeType,
  MerchantDashboard,
  PaymentProvider,
  PaymentsFinding,
} from '../types/provider.js';
import { paymentsConfigSchema } from './schema.js';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_CHECKOUT_MINUTES = 1440;
const DEFAULT_INVOICE_DAYS = 30;

/** Stripe's (and the general) recommendation: sellers with less than a full dashboard get destination charges. */
const DEFAULT_CHARGE_TYPE: Record<MerchantDashboard, ChargeType> = {
  full: 'direct',
  express: 'destination',
  none: 'destination',
};

/** Nobody: the default for policies whose feature is off. */
const NOBODY: AccessPolicy = { roles: ['payments:disabled'] };

export interface NormalizedPayments {
  config: NormalizedPaymentsConfig;
  provider: PaymentProvider;
  findings: PaymentsFinding[];
}

export function normalizePaymentsConfig(input: PaymentsConfig): NormalizedPayments {
  const parsed = paymentsConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new PlumbusError(
      ErrorCode.Validation,
      `createPayments: invalid config — ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
      { reason: 'payments_config', issues },
    );
  }

  const provider = input.provider;
  const dashboards: NormalizedPaymentsConfig['dashboards'] = {};
  const chargeType: NormalizedPaymentsConfig['chargeType'] = {};
  for (const name of ['full', 'express', 'none'] as const) {
    const option = input.dashboards?.[name];
    if (option === undefined) continue;
    const defaults = provider.defaultResponsibilities(name);
    dashboards[name] =
      option === true
        ? defaults
        : { fees: option.fees ?? defaults.fees, losses: option.losses ?? defaults.losses };
    chargeType[name] =
      typeof input.chargeType === 'string'
        ? input.chargeType
        : (input.chargeType?.[name] ?? DEFAULT_CHARGE_TYPE[name]);
  }

  const sellers: AccessPolicy = input.access.sellers ?? NOBODY;
  const refunds = input.access.refunds ?? sellers;
  const billingCustomer = input.billing?.customer ?? null;
  const subscriptionFee =
    input.subscriptions?.platformFeePercent ??
    (input.platformFee && typeof input.platformFee === 'object' && !input.platformFee.fixed
      ? (input.platformFee.percent ?? 0)
      : 0);

  const config: NormalizedPaymentsConfig = {
    seller: input.seller ? { owner: input.seller.owner } : null,
    access: {
      sellers,
      refunds,
      disputes: input.access.disputes ?? refunds,
      billing:
        input.access.billing ??
        (billingCustomer === 'seller'
          ? sellers
          : billingCustomer === 'user'
            ? { tenantScoped: true }
            : NOBODY),
      entitlements: input.access.entitlements ?? { tenantScoped: true },
    },
    dashboards,
    defaultDashboard: input.defaultDashboard ?? null,
    onboarding: {
      modes: input.onboarding?.modes ? [...new Set(input.onboarding.modes)] : ['hosted'],
      collect: input.onboarding?.collect ?? 'currently_due',
    },
    countries: {
      allowed: input.countries?.allowed ?? null,
      default: input.countries?.default ?? null,
    },
    chargeType,
    destination: { onBehalfOf: input.destination?.onBehalfOf ?? false },
    transfers: { enabled: input.transfers?.enabled ?? false },
    currencies: input.currencies ?? null,
    platformFee: input.platformFee ?? null,
    refunds: {
      refundPlatformFee: input.refunds?.refundPlatformFee ?? false,
      reverseTransfer: input.refunds?.reverseTransfer ?? true,
    },
    checkout: {
      expiresAfterMinutes: input.checkout?.expiresAfterMinutes ?? DEFAULT_CHECKOUT_MINUTES,
      ui: input.checkout?.ui ?? 'hosted',
      locale: input.checkout?.locale ?? null,
      allowPromotionCodes: input.checkout?.allowPromotionCodes ?? false,
      automaticTax: input.checkout?.automaticTax ?? false,
      billingAddress: input.checkout?.billingAddress ?? null,
      phone: input.checkout?.phone ?? false,
      shippingCountries: input.checkout?.shippingCountries ?? null,
      submitType: input.checkout?.submitType ?? null,
    },
    invoices: { daysUntilDue: input.invoices?.daysUntilDue ?? DEFAULT_INVOICE_DAYS },
    subscriptions: {
      enabled: input.subscriptions?.enabled ?? false,
      platformFeePercent: subscriptionFee,
    },
    payouts: {
      schedule: input.payouts?.schedule ?? null,
      sellersMayChangeSchedule: input.payouts?.sellersMayChangeSchedule ?? false,
      instant: input.payouts?.instant ?? false,
    },
    embedded: {
      allowRefunds: input.embedded?.allowRefunds ?? true,
      allowDisputeManagement: input.embedded?.allowDisputeManagement ?? true,
    },
    billing: input.billing
      ? {
          customer: input.billing.customer,
          plans: input.billing.plans ?? {},
          meters: input.billing.meters ?? {},
          features: input.billing.features ?? {},
          trialDays: input.billing.trialDays ?? null,
          allowPromotionCodes: input.billing.allowPromotionCodes ?? false,
          automaticTax: input.billing.automaticTax ?? false,
          prorate: input.billing.prorate ?? true,
        }
      : null,
    urls: {
      onboardingReturn: input.urls.onboardingReturn ?? null,
      onboardingRefresh: input.urls.onboardingRefresh ?? null,
      checkoutSuccess: input.urls.checkoutSuccess ?? null,
      checkoutCancel: input.urls.checkoutCancel ?? null,
      checkoutReturn: input.urls.checkoutReturn ?? null,
      setupSuccess: input.urls.setupSuccess ?? null,
      setupCancel: input.urls.setupCancel ?? null,
      portalReturn: input.urls.portalReturn ?? null,
      billingSuccess: input.urls.billingSuccess ?? null,
      billingCancel: input.urls.billingCancel ?? null,
      billingPortalReturn: input.urls.billingPortalReturn ?? null,
      linkCompleted: input.urls.linkCompleted ?? null,
    },
    webhooks: {
      path: input.webhooks?.path ?? `/payments/webhooks/${provider.id}`,
      bodyLimitBytes: input.webhooks?.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
      storePayload: input.webhooks?.storePayload ?? false,
    },
    appId: input.appId ?? null,
  };

  const findings = [
    ...checkGeneralRules(config, input),
    ...checkProviderSupport(config, provider),
    ...provider.validateConfig(config),
  ];
  const errors = findings.filter((f) => f.level === 'error');
  if (errors.length > 0) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `createPayments: ${errors.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`).join('; ')}`,
      { reason: 'payments_config', findings: errors },
    );
  }

  return { config, provider, findings };
}

/** Decimal places of a finite number, e.g. 2.5 → 1. */
function decimals(value: number): number {
  const [mantissa = '', exponent = '0'] = value.toString().toLowerCase().split('e');
  const places = (mantissa.split('.')[1] ?? '').length - Number(exponent);
  return Math.max(places, 0);
}

function checkGeneralRules(
  config: NormalizedPaymentsConfig,
  input: PaymentsConfig,
): PaymentsFinding[] {
  const findings: PaymentsFinding[] = [];
  const error = (code: string, path: string, message: string) =>
    findings.push({ level: 'error', code, path, message });
  const offered = Object.keys(config.dashboards) as MerchantDashboard[];

  if (!config.seller && !config.billing) {
    error(
      'payments_nothing_enabled',
      'seller',
      'Configure seller (your users charge their clients), billing (you bill your customers), or both',
    );
  }

  if (config.seller) {
    if (!input.access.sellers) {
      error('sellers_access_required', 'access.sellers', 'access.sellers is required with seller');
    }
    if (offered.length === 0) {
      error(
        'dashboards_required',
        'dashboards',
        'Offer at least one dashboard (full, express, or none)',
      );
    }
    for (const url of ['onboardingReturn', 'onboardingRefresh'] as const) {
      if (!config.urls[url])
        error('url_required', `urls.${url}`, `urls.${url} is required with seller`);
    }
    const pages =
      config.checkout.ui === 'hosted'
        ? (['checkoutSuccess', 'checkoutCancel'] as const)
        : (['checkoutReturn'] as const);
    for (const url of pages) {
      if (!config.urls[url]) {
        error(
          'url_required',
          `urls.${url}`,
          `urls.${url} is required for ${config.checkout.ui} payment pages`,
        );
      }
    }
  } else {
    for (const [path, set] of [
      ['dashboards', offered.length > 0],
      ['transfers.enabled', config.transfers.enabled],
      ['subscriptions.enabled', config.subscriptions.enabled],
      ['payouts', Boolean(input.payouts)],
      ['chargeType', input.chargeType !== undefined],
    ] as const) {
      if (set) error('seller_required', path, `${path} needs seller`);
    }
  }

  if (config.defaultDashboard && !offered.includes(config.defaultDashboard)) {
    error(
      'default_dashboard_not_offered',
      'defaultDashboard',
      `defaultDashboard "${config.defaultDashboard}" is not in dashboards (${offered.join(', ')})`,
    );
  }

  if (offered.length > 1 && !config.defaultDashboard) {
    findings.push({
      level: 'info',
      code: 'seller_must_choose_dashboard',
      path: 'defaultDashboard',
      message: `Several dashboards are offered (${offered.join(', ')}); startMerchantOnboarding needs a dashboard in its input`,
    });
  }

  if (input.chargeType && typeof input.chargeType === 'object') {
    for (const name of Object.keys(input.chargeType) as MerchantDashboard[]) {
      if (!offered.includes(name)) {
        findings.push({
          level: 'warning',
          code: 'charge_type_for_unoffered_dashboard',
          path: `chargeType.${name}`,
          message: `chargeType.${name} is set but the ${name} dashboard is not offered`,
        });
      }
    }
  }

  const { allowed, default: defaultCountry } = config.countries;
  if (defaultCountry && allowed && !allowed.includes(defaultCountry)) {
    error(
      'default_country_not_allowed',
      'countries.default',
      `countries.default "${defaultCountry}" is not in countries.allowed`,
    );
  }

  for (const name of offered) {
    const option = config.dashboards[name];
    const destination = config.chargeType[name] === 'destination';
    if ((destination || option?.fees === 'platform') && config.platformFee === null) {
      findings.push({
        level: 'warning',
        code: 'platform_pays_fees_without_cut',
        path: destination ? `chargeType.${name}` : `dashboards.${name}.fees`,
        message: `Your platform pays processing fees for ${name}-dashboard sellers${destination ? ' (destination charges)' : ''}, but platformFee is not set, so every charge costs you money`,
      });
    }
  }

  if (config.destination.onBehalfOf && !Object.values(config.chargeType).includes('destination')) {
    findings.push({
      level: 'info',
      code: 'on_behalf_of_unused',
      path: 'destination.onBehalfOf',
      message: 'destination.onBehalfOf is set but no dashboard uses destination charges',
    });
  }

  if (offered.includes('none') && !config.onboarding.modes.includes('embedded')) {
    findings.push({
      level: 'info',
      code: 'no_dashboard_needs_in_app_views',
      path: 'dashboards.none',
      message:
        'Sellers without a provider dashboard see payouts, disputes, and account settings only through createMerchantSession components your app renders',
    });
  }

  if (config.subscriptions.enabled) {
    const fee = config.subscriptions.platformFeePercent;
    if (typeof fee === 'number' && decimals(fee) > 2) {
      error(
        'subscription_fee_decimals',
        'subscriptions.platformFeePercent',
        `Subscription fees are a percentage with at most two decimals; ${fee} has more`,
      );
    }
    const feeIsDerived = input.subscriptions?.platformFeePercent === undefined;
    if (
      feeIsDerived &&
      config.platformFee !== null &&
      (typeof config.platformFee === 'function' || config.platformFee.fixed)
    ) {
      findings.push({
        level: 'warning',
        code: 'subscription_fee_not_derived',
        path: 'subscriptions.platformFeePercent',
        message:
          'Subscription payments can carry only a percentage fee; your platformFee is a function or has a fixed part, so subscriptions take no fee until you set subscriptions.platformFeePercent',
      });
    }
  }

  if (config.billing) {
    const { billing } = config;
    if (billing.customer === 'seller' && !config.seller) {
      error('seller_required', 'billing.customer', 'billing.customer "seller" needs seller');
    }
    if (billing.customer === 'tenant' && !input.access.billing) {
      error(
        'billing_access_required',
        'access.billing',
        'access.billing is required when billing.customer is "tenant" (who may change the tenant\'s plan?)',
      );
    }
    // Plan checkout lands on these; one-off purchases use the checkout URLs.
    if (Object.keys(billing.plans).length > 0) {
      for (const url of ['billingSuccess', 'billingCancel'] as const) {
        if (!config.urls[url])
          error('url_required', `urls.${url}`, `urls.${url} is required with billing plans`);
      }
    }
    for (const [planKey, plan] of Object.entries(billing.plans)) {
      for (const meterKey of plan.meters ?? []) {
        if (!billing.meters[meterKey]) {
          error(
            'unknown_meter',
            `billing.plans.${planKey}.meters`,
            `Plan "${planKey}" bills meter "${meterKey}", which billing.meters does not define`,
          );
        }
      }
      const currencies = new Set(Object.values(plan.prices).map((price) => price.currency));
      for (const meterKey of plan.meters ?? []) {
        const meterCurrency = billing.meters[meterKey]?.currency;
        if (meterCurrency && !currencies.has(meterCurrency)) {
          error(
            'meter_currency_mismatch',
            `billing.plans.${planKey}.meters`,
            `Meter "${meterKey}" is priced in ${meterCurrency}, but plan "${planKey}" has no ${meterCurrency} price`,
          );
        }
      }
    }
  }

  return findings;
}

/** Features a config turns on, and the provider methods each one needs. */
const FEATURE_METHODS: Array<{
  path: string;
  enabled: (config: NormalizedPaymentsConfig) => boolean;
  methods: Array<keyof PaymentProvider>;
}> = [
  {
    path: 'transfers.enabled',
    enabled: (c) => c.transfers.enabled,
    methods: ['createTransfer', 'reverseTransfer'],
  },
  {
    path: 'subscriptions.enabled',
    enabled: (c) => c.subscriptions.enabled,
    methods: [
      'createSubscriptionCheckout',
      'retrieveSubscription',
      'updateSubscription',
      'cancelSubscription',
      'createPortalSession',
    ],
  },
  {
    path: 'billing',
    enabled: (c) => c.billing !== null,
    methods: [
      'createBillingCustomer',
      'syncCatalog',
      'checkCatalog',
      'createSubscriptionCheckout',
      'retrieveSubscription',
      'updateSubscription',
      'cancelSubscription',
      'createPortalSession',
      'listEntitlements',
    ],
  },
  {
    path: 'billing.meters',
    enabled: (c) => Object.keys(c.billing?.meters ?? {}).length > 0,
    methods: ['recordUsage'],
  },
  {
    path: 'payouts',
    enabled: (c) =>
      c.payouts.schedule !== null || c.payouts.sellersMayChangeSchedule || c.payouts.instant,
    methods: ['retrievePayoutSettings', 'updatePayoutSchedule', 'listPayouts', 'createPayout'],
  },
];

function checkProviderSupport(
  config: NormalizedPaymentsConfig,
  provider: PaymentProvider,
): PaymentsFinding[] {
  const findings: PaymentsFinding[] = [];
  for (const feature of FEATURE_METHODS) {
    if (!feature.enabled(config)) continue;
    const missing = feature.methods.filter((method) => typeof provider[method] !== 'function');
    if (missing.length > 0) {
      findings.push({
        level: 'error',
        code: 'provider_feature_unsupported',
        path: feature.path,
        message: `${provider.displayName} does not support ${feature.path} (missing ${missing.join(', ')})`,
      });
    }
  }
  return findings;
}
