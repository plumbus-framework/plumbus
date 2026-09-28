import { isPlumbusError } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { listPaymentsConfigOptions } from '../config/schema.js';
import { createPayments } from '../runtime/create-payments.js';
import { createFakePaymentProvider } from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { baseConfig, urls } from './helpers.js';

function build(overrides: Partial<PaymentsConfig> = {}) {
  return createPayments(baseConfig(createFakePaymentProvider(), overrides));
}

function errorOf(fn: () => unknown): { message: string; metadata?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    if (isPlumbusError(err)) return err;
    throw err;
  }
  throw new Error('expected createPayments to throw');
}

describe('createPayments config', () => {
  it('applies defaults and the provider responsibilities for `true` dashboards', () => {
    const payments = build({ dashboards: { full: true, express: true }, defaultDashboard: 'full' });
    expect(payments.config.dashboards).toEqual({
      full: { fees: 'provider', losses: 'provider' },
      express: { fees: 'platform', losses: 'platform' },
    });
    expect(payments.config.onboarding).toEqual({ modes: ['hosted'], collect: 'currently_due' });
    expect(payments.config.webhooks).toEqual({
      path: '/payments/webhooks/fake',
      bodyLimitBytes: 1024 * 1024,
      storePayload: false,
    });
    expect(payments.config.checkout.expiresAfterMinutes).toBe(1440);
    expect(payments.config.refunds.refundPlatformFee).toBe(false);
    expect(payments.config.access.refunds).toEqual({ roles: ['seller'] });
    // Sellers without subscriptions, transfers, instant payouts, or billing: only what is on.
    expect(Object.keys(payments.capabilities).sort()).toEqual([
      'acceptDispute',
      'applyProviderState',
      'cancelCharge',
      'captureCharge',
      'chargeSavedMethod',
      'createCharge',
      'createClientPortalSession',
      'createMerchantSession',
      'createPaymentLink',
      'getCharge',
      'getMerchantAccount',
      'getPayoutSettings',
      'listCharges',
      'listClientPaymentMethods',
      'listClients',
      'listDisputes',
      'listPaymentLinks',
      'listPayouts',
      'openMerchantDashboard',
      'processProviderEvent',
      'recordProviderEvent',
      'refundCharge',
      'removeClientPaymentMethod',
      'respondToDispute',
      'saveClientPaymentMethod',
      'setPaymentLinkActive',
      'startMerchantOnboarding',
      'syncClientPaymentMethods',
      'syncMerchantAccount',
    ]);
    // Express sellers get destination charges by default (the provider's recommendation).
    expect(payments.config.chargeType).toEqual({ full: 'direct', express: 'destination' });
  });

  it('keeps explicit responsibilities over provider defaults', () => {
    const payments = build({ dashboards: { full: { losses: 'platform', fees: 'platform' } } });
    expect(payments.config.dashboards.full).toEqual({ fees: 'platform', losses: 'platform' });
  });

  it('rejects a config with no dashboards', () => {
    const err = errorOf(() => build({ dashboards: {} }));
    expect(err.message).toContain('Offer at least one dashboard');
  });

  it('takes one charge type for every dashboard, or one per dashboard', () => {
    const all = build({ dashboards: { full: true, express: true }, chargeType: 'direct' });
    expect(all.config.chargeType).toEqual({ full: 'direct', express: 'direct' });
    const mixed = build({
      dashboards: { full: true, none: true },
      defaultDashboard: 'full',
      chargeType: { full: 'destination' },
    });
    expect(mixed.config.chargeType).toEqual({ full: 'destination', none: 'destination' });
  });

  it('rejects a default dashboard that is not offered', () => {
    const err = errorOf(() => build({ defaultDashboard: 'express' }));
    expect(err.message).toContain('defaultDashboard "express" is not in dashboards');
  });

  it('rejects a default country outside the allowed list', () => {
    const err = errorOf(() => build({ countries: { allowed: ['GB'], default: 'US' } }));
    expect(err.message).toContain('countries.default "US" is not in countries.allowed');
  });

  it('rejects malformed values with the offending path', () => {
    const err = errorOf(() =>
      build({
        currencies: ['USD'],
        urls: { ...baseConfig(createFakePaymentProvider()).urls, checkoutCancel: 'nope' },
      }),
    );
    expect(err.message).toContain('currencies.0');
    expect(err.message).toContain('urls.checkoutCancel');
  });

  it('warns when the platform pays fees but takes no cut', () => {
    const payments = build({ dashboards: { express: true } });
    expect(payments.findings.map((f) => f.code)).toContain('platform_pays_fees_without_cut');
    const withFee = build({ dashboards: { express: true }, platformFee: { percent: 5 } });
    expect(withFee.findings.map((f) => f.code)).not.toContain('platform_pays_fees_without_cut');
  });

  it('explains that sellers must choose when several dashboards are offered', () => {
    const payments = build({ dashboards: { full: true, express: true } });
    expect(payments.findings).toContainEqual(
      expect.objectContaining({ level: 'info', code: 'seller_must_choose_dashboard' }),
    );
  });

  it('throws provider rule errors and keeps provider warnings', () => {
    const provider = createFakePaymentProvider();
    provider.validateConfig = () => [
      {
        level: 'error',
        code: 'bad_combo',
        message: 'express needs platform losses',
        path: 'dashboards.express',
      },
    ];
    const err = errorOf(() => createPayments(baseConfig(provider)));
    expect(err.message).toContain('dashboards.express: express needs platform losses');

    const warnProvider = createFakePaymentProvider();
    warnProvider.validateConfig = () => [
      { level: 'warning', code: 'heads_up', message: 'careful' },
    ];
    expect(createPayments(baseConfig(warnProvider)).findings.map((f) => f.code)).toContain(
      'heads_up',
    );
  });

  it('lists every option path for docs coverage', () => {
    const paths = listPaymentsConfigOptions();
    expect(paths).toEqual(
      expect.arrayContaining([
        'provider',
        'seller.owner',
        'access.refunds',
        'dashboards.express.losses',
        'platformFee.percent',
        'platformFee.fixed',
        'webhooks.storePayload',
        'appId',
      ]),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('provider setup follows the config', () => {
  it('tells the provider whether there are sellers, for doctor and webhook setup', async () => {
    const seen: [string, boolean | undefined][] = [];
    const withHooks = () =>
      Object.assign(createFakePaymentProvider(), {
        async diagnose(input: { sellers?: boolean }) {
          seen.push(['diagnose', input.sellers]);
          return [];
        },
        async setupWebhooks(input: { url: string; sellers?: boolean }) {
          seen.push(['setup', input.sellers]);
          return { destinations: [] };
        },
      });
    const marketplace = createPayments(baseConfig(withHooks()));
    // Billing only, no plans: a platform that bills its own customers once.
    const platform = createPayments({
      provider: withHooks(),
      billing: { customer: 'user' },
      access: { billing: { roles: ['admin'] } },
      urls,
    });
    await marketplace.diagnose({ live: true });
    await marketplace.setupWebhooks({ url: 'https://app.test/hook' });
    await platform.diagnose({ live: true });
    await platform.setupWebhooks({ url: 'https://app.test/hook' });
    expect(seen).toEqual([
      ['diagnose', true],
      ['setup', true],
      ['diagnose', false],
      ['setup', false],
    ]);
  });
});

describe('core runtime floor', () => {
  it('explains that core 0.7.7+ is required when field.bigint is missing', async () => {
    const { assertCoreSupportsPayments } = await import('../entities/index.js');
    expect(() => assertCoreSupportsPayments({ number: () => ({}) })).toThrow(
      'requires @plumbus/core 0.7.7 or newer',
    );
    expect(() => assertCoreSupportsPayments()).not.toThrow();
  });
});
