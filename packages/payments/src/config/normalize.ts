// ── Config normalization + rule checks ──
// Hard rules (combinations the provider would reject, or options this release
// does not ship) throw at startup. Advice is returned as warnings, matching
// Plumbus's advisory governance: the app decides, the framework explains.

import type { AccessPolicy } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { NormalizedPaymentsConfig, PaymentsConfig } from '../types/config.js';
import type { MerchantDashboard, PaymentProvider, PaymentsFinding } from '../types/provider.js';
import { paymentsConfigSchema } from './schema.js';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_CHECKOUT_MINUTES = 1440;

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
  for (const name of ['full', 'express', 'none'] as const) {
    const option = input.dashboards[name];
    if (option === undefined) continue;
    const defaults = provider.defaultResponsibilities(name);
    dashboards[name] =
      option === true
        ? defaults
        : { fees: option.fees ?? defaults.fees, losses: option.losses ?? defaults.losses };
  }

  const sellers: AccessPolicy = input.access.sellers;
  const config: NormalizedPaymentsConfig = {
    seller: { owner: input.seller.owner },
    access: { sellers, refunds: input.access.refunds ?? sellers },
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
    chargeType: input.chargeType ?? 'direct',
    currencies: input.currencies ?? null,
    platformFee: input.platformFee ?? null,
    refunds: { refundPlatformFee: input.refunds?.refundPlatformFee ?? false },
    checkout: {
      expiresAfterMinutes: input.checkout?.expiresAfterMinutes ?? DEFAULT_CHECKOUT_MINUTES,
    },
    embedded: {
      allowRefunds: input.embedded?.allowRefunds ?? true,
      allowDisputeManagement: input.embedded?.allowDisputeManagement ?? true,
    },
    urls: { ...input.urls },
    webhooks: {
      path: input.webhooks?.path ?? `/payments/webhooks/${provider.id}`,
      bodyLimitBytes: input.webhooks?.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
      storePayload: input.webhooks?.storePayload ?? false,
    },
    appId: input.appId ?? null,
  };

  const findings = [...checkGeneralRules(config), ...provider.validateConfig(config)];
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

function checkGeneralRules(config: NormalizedPaymentsConfig): PaymentsFinding[] {
  const findings: PaymentsFinding[] = [];
  const offered = Object.keys(config.dashboards) as MerchantDashboard[];

  if (config.chargeType !== 'direct') {
    findings.push({
      level: 'error',
      code: 'charge_type_unavailable',
      path: 'chargeType',
      message: `"${config.chargeType}" charges are documented but not available in this release; use "direct"`,
    });
  }

  if (config.defaultDashboard && !offered.includes(config.defaultDashboard)) {
    findings.push({
      level: 'error',
      code: 'default_dashboard_not_offered',
      path: 'defaultDashboard',
      message: `defaultDashboard "${config.defaultDashboard}" is not in dashboards (${offered.join(', ')})`,
    });
  }

  if (offered.length > 1 && !config.defaultDashboard) {
    findings.push({
      level: 'info',
      code: 'seller_must_choose_dashboard',
      path: 'defaultDashboard',
      message: `Several dashboards are offered (${offered.join(', ')}); startMerchantOnboarding needs a dashboard in its input`,
    });
  }

  const { allowed, default: defaultCountry } = config.countries;
  if (defaultCountry && allowed && !allowed.includes(defaultCountry)) {
    findings.push({
      level: 'error',
      code: 'default_country_not_allowed',
      path: 'countries.default',
      message: `countries.default "${defaultCountry}" is not in countries.allowed`,
    });
  }

  for (const name of offered) {
    const option = config.dashboards[name];
    if (option?.fees === 'platform' && config.platformFee === null) {
      findings.push({
        level: 'warning',
        code: 'platform_pays_fees_without_cut',
        path: `dashboards.${name}.fees`,
        message: `Sellers on the ${name} dashboard have your platform paying processing fees, but platformFee is not set, so every charge costs you money`,
      });
    }
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

  return findings;
}
