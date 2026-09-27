import { createPayments, type PaymentsConfig } from '@plumbus/payments';
import { describe, expect, it } from 'vitest';
import { stripeProvider } from '../provider.js';

const urls = {
  onboardingReturn: 'https://app.test/r',
  onboardingRefresh: 'https://app.test/f',
  checkoutSuccess: 'https://app.test/s',
  checkoutCancel: 'https://app.test/c',
};

function build(dashboards: PaymentsConfig['dashboards'], extra: Partial<PaymentsConfig> = {}) {
  return createPayments({
    provider: stripeProvider({ secretKey: 'sk_test_1', webhookSecrets: ['whsec_1'] }),
    seller: { owner: 'user' },
    access: { sellers: { roles: ['seller'] } },
    dashboards,
    defaultDashboard: Object.keys(dashboards)[0] as 'full',
    countries: { default: 'US' },
    urls,
    ...extra,
  });
}

describe('Stripe Connect config rules', () => {
  it('defaults full and none to Stripe liability and Express to platform liability', () => {
    const payments = build(
      { full: true, express: true, none: true },
      { platformFee: { percent: 5 } },
    );
    expect(payments.config.dashboards).toEqual({
      full: { fees: 'provider', losses: 'provider' },
      express: { fees: 'platform', losses: 'platform' },
      none: { fees: 'provider', losses: 'provider' },
    });
  });

  it('refuses Express with Stripe-covered losses or Stripe-collected fees', () => {
    expect(() => build({ express: { losses: 'provider' } })).toThrow(
      'Stripe requires Express-dashboard sellers to have your platform pay fees and cover losses',
    );
    expect(() => build({ express: { fees: 'provider', losses: 'platform' } })).toThrow(
      'Stripe requires fees: "platform" whenever losses: "platform"',
    );
  });

  it('refuses platform-covered losses without platform-paid fees on any dashboard', () => {
    expect(() => build({ full: { losses: 'platform' } })).toThrow('fees: "platform"');
  });

  it('allows the platform to take liability on full and none, with warnings', () => {
    const payments = build(
      {
        full: { fees: 'platform', losses: 'platform' },
        none: { fees: 'platform', losses: 'platform' },
      },
      { platformFee: { percent: 3 } },
    );
    const codes = payments.findings.map((f) => `${f.path}:${f.code}`);
    expect(codes).toContain('dashboards.full.losses:stripe_platform_covers_losses');
    expect(codes).toContain('dashboards.none:stripe_platform_collects_requirements');
    expect(codes).toContain('dashboards.none:stripe_radar_rules');
    expect(codes).not.toContain('dashboards.full:stripe_radar_rules');
  });
});
