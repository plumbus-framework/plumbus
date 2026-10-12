// ── Stripe Connect rules for the payments config ──
// Encodes what Stripe's Accounts v2 API accepts (hard errors) and what Stripe
// recommends (warnings/info). Sources: Stripe "Configure the behavior of
// connected accounts", "Recommended Connect integrations", and the v2 account
// create error codes. Recommended pairs: full dashboard with direct charges;
// Express or no dashboard with destination charges and platform liability.

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
    const chargeType = config.chargeType[name] ?? 'direct';
    if (
      chargeType === 'destination' &&
      (option.fees !== 'platform' || option.losses !== 'platform')
    ) {
      // With no dashboard, platform losses also make the platform collect identity requirements.
      findings.push({
        level: name === 'none' ? 'info' : 'warning',
        code: 'stripe_destination_recommends_platform_liability',
        path,
        message:
          name === 'none'
            ? 'Stripe recommends fees: "platform" and losses: "platform" for sellers paid by destination charges; with no dashboard that also makes your platform collect their identity requirements, so keeping Stripe-covered losses is a reasonable choice'
            : 'Stripe recommends fees: "platform" and losses: "platform" for sellers paid by destination charges (your platform is the merchant of record and pays the Stripe fees either way)',
      });
    }
    if (name !== 'full' && chargeType === 'direct') {
      findings.push({
        level: 'warning',
        code: 'stripe_direct_charges_on_limited_dashboard',
        path: `chargeType.${name}`,
        message: `Stripe recommends destination charges for ${name}-dashboard sellers: with direct charges their customers see the seller as the merchant, and the seller handles refunds and disputes with limited tools`,
      });
      findings.push({
        level: 'info',
        code: 'stripe_radar_rules',
        path,
        message: `Sellers on the ${name} dashboard cannot set their own Radar fraud rules, and your platform rules do not apply to their direct charges; set rules per seller with "View Dashboard as this account"`,
      });
    }
    if (name === 'full' && chargeType === 'destination') {
      findings.push({
        level: 'info',
        code: 'stripe_destination_on_full_dashboard',
        path: `chargeType.${name}`,
        message:
          'Stripe recommends direct charges for full-dashboard sellers, who run their own Stripe account; with destination charges your platform is the merchant of record for their sales',
      });
    }
  }
  return findings;
}
