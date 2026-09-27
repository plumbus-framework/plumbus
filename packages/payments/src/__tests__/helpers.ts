import type { ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { MockEventService } from '@plumbus/core/testing';
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

export function setup(overrides: Partial<PaymentsConfig> = {}, fakeLivemode = false) {
  const fake = createFakePaymentProvider({ livemode: fakeLivemode });
  const payments = createPayments(baseConfig(fake, overrides));
  const ctx = createPaymentsTestContext(payments, {
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
export async function onboardedSeller(overrides: Partial<PaymentsConfig> = {}) {
  const env = setup(overrides);
  const onboarding = await env.run<any>('startMerchantOnboarding', {});
  const accountId = env.fake.accounts.keys().next().value as string;
  env.fake.completeOnboarding(accountId);
  await env.run('syncMerchantAccount', {});
  return { ...env, onboarding, accountId };
}
