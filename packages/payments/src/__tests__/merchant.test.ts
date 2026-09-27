import { describe, expect, it } from 'vitest';
import { PaymentEventName } from '../events/index.js';
import { onboardedSeller, setup } from './helpers.js';

describe('startMerchantOnboarding', () => {
  it('creates one seller account for the caller and returns a hosted onboarding link', async () => {
    const env = setup();
    const first = await env.run<any>('startMerchantOnboarding', { email: 'ada@example.com' });

    expect(first.created).toBe(true);
    expect(first.onboardingUrl).toMatch(/^https:\/\/connect\.fake\.test\/onboard\/acct_fake_/);
    expect(first.merchantAccount).toMatchObject({
      ownerType: 'user',
      ownerId: 'seller-1',
      dashboard: 'full',
      feesCollector: 'provider',
      lossesCollector: 'provider',
      status: 'onboarding',
      chargesEnabled: false,
      country: 'US',
      livemode: false,
    });
    const create = env.fake.calls.find((c) => c.method === 'createMerchantAccount')?.input as any;
    expect(create.metadata).toEqual({
      plumbus_tenant_id: 'tenant-a',
      plumbus_owner_type: 'user',
      plumbus_owner_id: 'seller-1',
    });
    expect(create.idempotencyKey).toBe('plumbus-merchant:tenant-a:user:seller-1:test:full:US');
    expect(env.fake.calls.find((c) => c.method === 'createOnboardingLink')?.input).toMatchObject({
      returnUrl: 'https://app.test/payments/return',
      refreshUrl: 'https://app.test/payments/refresh',
      collectEventuallyDue: false,
    });

    const second = await env.run<any>('startMerchantOnboarding', {});
    expect(second.created).toBe(false);
    expect(second.merchantAccount.id).toBe(first.merchantAccount.id);
    expect(env.fake.accounts.size).toBe(1);
  });

  it('gives each user their own account and one account per tenant in tenant mode', async () => {
    const env = setup();
    const a = await env.run<any>('startMerchantOnboarding', {}, env.as('seller-1'));
    const b = await env.run<any>('startMerchantOnboarding', {}, env.as('seller-2'));
    expect(a.merchantAccount.id).not.toBe(b.merchantAccount.id);

    const tenantEnv = setup({ seller: { owner: 'tenant' } });
    const first = await tenantEnv.run<any>('startMerchantOnboarding', {}, tenantEnv.as('admin-1'));
    const second = await tenantEnv.run<any>('startMerchantOnboarding', {}, tenantEnv.as('admin-2'));
    expect(first.merchantAccount).toMatchObject({ ownerType: 'tenant', ownerId: 'tenant-a' });
    expect(second.merchantAccount.id).toBe(first.merchantAccount.id);
  });

  it('lets the seller pick among offered dashboards and records the responsibilities', async () => {
    const env = setup({
      dashboards: { full: true, express: true },
      platformFee: { percent: 10 },
    });
    const missing = await env.tryRun('startMerchantOnboarding', {});
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.message).toContain('Choose a dashboard');

    const express = await env.run<any>('startMerchantOnboarding', { dashboard: 'express' });
    expect(express.merchantAccount).toMatchObject({
      dashboard: 'express',
      feesCollector: 'platform',
      lossesCollector: 'platform',
    });

    const change = await env.tryRun('startMerchantOnboarding', { dashboard: 'full' });
    expect(change.success).toBe(false);
    if (!change.success) {
      expect(change.error.code).toBe('conflict');
      expect(change.error.message).toContain('cannot change');
    }
  });

  it('refuses dashboards that are not offered and countries that are not allowed', async () => {
    const env = setup({ countries: { allowed: ['GB'] } });
    const notOffered = await env.tryRun('startMerchantOnboarding', {
      dashboard: 'none',
      country: 'GB',
    });
    expect(notOffered.success).toBe(false);

    const noCountry = await env.tryRun('startMerchantOnboarding', {});
    expect(noCountry.success).toBe(false);
    if (!noCountry.success) expect(noCountry.error.message).toContain('country');

    const blocked = await env.tryRun('startMerchantOnboarding', { country: 'US' });
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error.message).toContain('not supported');

    const ok = await env.run<any>('startMerchantOnboarding', { country: 'GB' });
    expect(ok.merchantAccount.country).toBe('GB');
  });

  it('returns no link in embedded mode and rejects modes that are not enabled', async () => {
    const env = setup({ onboarding: { modes: ['embedded'] } });
    const result = await env.run<any>('startMerchantOnboarding', {});
    expect(result.onboardingUrl).toBeNull();
    const hosted = await env.tryRun('startMerchantOnboarding', { mode: 'hosted' });
    expect(hosted.success).toBe(false);
  });

  it('denies callers outside access.sellers and callers without a tenant', async () => {
    const env = setup();
    const denied = await env.tryRun(
      'startMerchantOnboarding',
      {},
      env.as('user-9', 'tenant-a', ['viewer']),
    );
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('forbidden');

    const noTenant = await env.tryRun(
      'startMerchantOnboarding',
      {},
      { ...env.ctx, auth: { userId: 'seller-1', roles: ['seller'], scopes: [], provider: 'test' } },
    );
    expect(noTenant.success).toBe(false);
    if (!noTenant.success) expect(noTenant.error.message).toContain('tenant');
  });

  it('keeps using the existing row when a concurrent call created it first', async () => {
    const env = setup();
    const repo = (env.ctx.data as any).PaymentMerchantAccount;
    const create = repo.create.bind(repo);
    repo.create = async (data: any) => {
      await create(data);
      throw new Error('duplicate key value violates unique constraint');
    };
    const result = await env.run<any>('startMerchantOnboarding', {});
    expect(result.created).toBe(false);
    expect(result.merchantAccount.ownerId).toBe('seller-1');
  });
});

describe('merchant status capabilities', () => {
  it('reads null before onboarding and the account after', async () => {
    const env = setup();
    expect(await env.run<any>('getMerchantAccount', {})).toEqual({ merchantAccount: null });
    await env.run('startMerchantOnboarding', {});
    const after = await env.run<any>('getMerchantAccount', {});
    expect(after.merchantAccount.status).toBe('onboarding');
  });

  it('syncMerchantAccount pulls fresh status and emits one update per change', async () => {
    const env = await onboardedSeller();
    const updates = env.emitted(PaymentEventName.MerchantUpdated);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      ownerType: 'user',
      ownerId: 'seller-1',
      status: 'active',
      previousStatus: 'onboarding',
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsDue: [],
    });

    await env.run('syncMerchantAccount', {});
    expect(env.emitted(PaymentEventName.MerchantUpdated)).toHaveLength(1);

    env.fake.restrictAccount(env.accountId, 'Updated ID document');
    const restricted = await env.run<any>('syncMerchantAccount', {});
    expect(restricted.merchantAccount).toMatchObject({
      status: 'restricted',
      chargesEnabled: false,
      requirementsPastDue: ['Updated ID document'],
    });
    expect(env.emitted(PaymentEventName.MerchantUpdated)).toHaveLength(2);
  });

  it('openMerchantDashboard links to the provider dashboard, except for dashboard none', async () => {
    const env = await onboardedSeller({
      dashboards: { express: true },
      platformFee: { percent: 5 },
    });
    const link = await env.run<any>('openMerchantDashboard', {});
    expect(link).toEqual({
      url: `https://dashboard.fake.test/express/${env.accountId}`,
      dashboard: 'express',
    });

    const none = await onboardedSeller({ dashboards: { none: true } });
    const refused = await none.tryRun('openMerchantDashboard', {});
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.code).toBe('conflict');
  });

  it('createMerchantSession defaults components by dashboard and guards embedded onboarding', async () => {
    const env = await onboardedSeller({
      dashboards: { none: true },
      onboarding: { modes: ['hosted', 'embedded'] },
      embedded: { allowRefunds: false },
    });
    const session = await env.run<any>('createMerchantSession', {});
    expect(session.components).toEqual([
      'onboarding',
      'notifications',
      'account',
      'payments',
      'payouts',
      'disputes',
    ]);
    expect(session.publishableKey).toBe('pk_fake');
    expect(env.fake.calls.find((c) => c.method === 'createMerchantSession')?.input).toMatchObject({
      allowRefunds: false,
      allowDisputeManagement: true,
    });

    const hostedOnly = await onboardedSeller();
    const refused = await hostedOnly.tryRun('createMerchantSession', {
      components: ['onboarding'],
    });
    expect(refused.success).toBe(false);
    const payouts = await hostedOnly.run<any>('createMerchantSession', { components: ['payouts'] });
    expect(payouts.components).toEqual(['payouts']);
  });

  it('requires a connected account for session, sync, and dashboard', async () => {
    const env = setup();
    for (const name of [
      'createMerchantSession',
      'syncMerchantAccount',
      'openMerchantDashboard',
    ] as const) {
      const result = await env.tryRun(name, {});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('notFound');
    }
  });
});
