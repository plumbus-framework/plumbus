// ── Stripe Connect rules for the payments config ──
// Encodes what Stripe's Accounts v2 API accepts (hard errors) and what Stripe
// recommends (warnings/info). Sources: Stripe "Configure the behavior of
// connected accounts", "Recommended Connect integrations", and the v2 account
// create error codes.

import type {
  MerchantDashboard,
  NormalizedPaymentsConfig,
  PaymentsFinding,
  Responsibility,
} from '@plumbus/payments';

export function stripeDefaultResponsibilities(dashboard: MerchantDashboard): {
  fees: Responsibility;
  losses: Responsibility;
} {
  // Express requires your platform to carry both; full and none default to Stripe.
  return dashboard === 'express'
    ? { fees: 'platform', losses: 'platform' }
    : { fees: 'provider', losses: 'provider' };
}

export function validateStripeConfig(config: NormalizedPaymentsConfig): PaymentsFinding[] {
  const findings: PaymentsFinding[] = [];
  type Entry = [MerchantDashboard, { fees: Responsibility; losses: Responsibility }];
  for (const [name, option] of Object.entries(config.dashboards) as Entry[]) {
    const path = `dashboards.${name}`;
    if (name === 'express' && (option.fees !== 'platform' || option.losses !== 'platform')) {
      findings.push({
        level: 'error',
        code: 'stripe_express_needs_platform_liability',
        path,
        message:
          'Stripe requires Express-dashboard sellers to have your platform pay fees and cover losses (fees: "platform", losses: "platform")',
      });
    }
    if (option.losses === 'platform' && option.fees !== 'platform') {
      findings.push({
        level: 'error',
        code: 'stripe_platform_losses_need_platform_fees',
        path,
        message: 'Stripe requires fees: "platform" whenever losses: "platform"',
      });
    }
    if (option.losses === 'platform') {
      findings.push({
        level: 'warning',
        code: 'stripe_platform_covers_losses',
        path: `${path}.losses`,
        message:
          'Your platform covers negative balances for these sellers; Stripe may hold a reserve on your balance and expects you to manage seller risk',
      });
    }
    if (name === 'none' && option.losses === 'platform') {
      findings.push({
        level: 'warning',
        code: 'stripe_platform_collects_requirements',
        path,
        message:
          'With no dashboard and platform-covered losses, your platform is responsible for collecting seller identity requirements (Stripe onboarding pages can still do the collecting)',
      });
    }
    if (name !== 'full') {
      findings.push({
        level: 'info',
        code: 'stripe_radar_rules',
        path,
        message: `Sellers on the ${name} dashboard cannot set their own Radar fraud rules, and your platform rules do not apply to their direct charges; set rules per seller with "View Dashboard as this account"`,
      });
    }
  }
  return findings;
}
