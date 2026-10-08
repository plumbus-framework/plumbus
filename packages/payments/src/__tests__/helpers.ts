import type { ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { MockEventService, TestContextOptions } from '@plumbus/core/testing';
import { createPayments } from '../runtime/create-payments.js';
import type { PaymentsConfig } from '../types/config.js';
import {
  createFakePaymentProvider,
  createPaymentsTestContext,
  type FakePaymentProvider,
  withAuth,
} from '../testing/index.js';

export const urls = {
  onboardingReturn: 'https://app.test/payments/return',
  onboardingRefresh: 'https://app.test/payments/refresh',
  checkoutSuccess: 'https://app.test/paid/{chargeId}',
  checkoutCancel: 'https://app.test/cancelled/{chargeId}',
  checkoutReturn: 'https://app.test/returned/{chargeId}',
  setupSuccess: 'https://app.test/saved/{clientId}',
  setupCancel: 'https://app.test/not-saved/{clientId}',
  portalReturn: 'https://app.test/account',
  billingSuccess: 'https://app.test/billing/welcome',
  billingCancel: 'https://app.test/billing/plans',
  billingPortalReturn: 'https://app.test/billing',
  linkCompleted: 'https://app.test/thanks',
};

export function baseConfig(
  provider: FakePaymentProvider,
  overrides: Partial<PaymentsConfig> = {},
): PaymentsConfig {
  return {
    provider,
    seller: { owner: 'user' },
    access: { sellers: { roles: ['seller'] } },
    dashboards: { full: true },
    countries: { default: 'US' },
    urls,
    ...overrides,
  };
}

/** A clock that moves one second forward on every read, so reads are strictly ordered. */
export function tickingClock(start = '2026-09-27T00:00:00.000Z') {
  let current = Date.parse(start);
  return {
    now: () => {
      current += 1000;
      return new Date(current);
    },
  };
}

export function setup(
  overrides: Partial<PaymentsConfig> = {},
  fakeLivemode = false,
  contextOptions: Pick<TestContextOptions, 'time'> = {},
) {
  const fake = createFakePaymentProvider({ livemode: fakeLivemode });
  const payments = createPayments(baseConfig(fake, overrides));
  const ctx = createPaymentsTestContext(payments, {
    ...contextOptions,
    auth: { userId: 'seller-1', tenantId: 'tenant-a', roles: ['seller'] },
  });
  const as = (userId: string, tenantId = 'tenant-a', roles = ['seller']) =>
    withAuth(ctx, { userId, tenantId, roles, scopes: [], provider: 'test' });
  const run = async <T = any>(
    name: keyof typeof payments.capabilities,
    input: unknown,
    context: ExecutionContext = ctx,
  ): Promise<T> => {
    const result = await executeCapability(payments.capabilities[name] as any, context, input);
    if (!result.success) throw result.error;
    return result.data as T;
  };
  const tryRun = (name: keyof typeof payments.capabilities, input: unknown, context = ctx) =>
    executeCapability(payments.capabilities[name] as any, context, input);
  const events = ctx.events as MockEventService;
  const emitted = (name: string) =>
    events.emitted.filter((e) => e.eventName === name).map((e) => e.payload as any);
  return { fake, payments, ctx, as, run, tryRun, events, emitted };
}

/** Onboard `seller-1` and finish onboarding at the fake provider. */
export async function onboardedSeller(
  overrides: Partial<PaymentsConfig> = {},
  contextOptions: Pick<TestContextOptions, 'time'> = {},
) {
  const env = setup(overrides, false, contextOptions);
  const onboarding = await env.run<any>('startMerchantOnboarding', {});
  const accountId = env.fake.accounts.keys().next().value as string;
  env.fake.completeOnboarding(accountId);
  await env.run('syncMerchantAccount', {});
  return { ...env, onboarding, accountId };
}
