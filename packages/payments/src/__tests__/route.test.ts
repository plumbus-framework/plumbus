import type { RouteGeneratorConfig } from '@plumbus/core';
import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPayments } from '../runtime/create-payments.js';
import { registerPaymentRoutes } from '../runtime/webhook-route.js';
import {
  createFakePaymentProvider,
  createPaymentsTestContext,
  FAKE_SIGNATURE_HEADER,
} from '../testing/index.js';
import type { PaymentsConfig } from '../types/config.js';
import { baseConfig } from './helpers.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

async function build(overrides: Partial<PaymentsConfig> = {}) {
  const fake = createFakePaymentProvider();
  const payments = createPayments(baseConfig(fake, overrides));
  const base = createPaymentsTestContext(payments, {
    auth: { userId: 'seller-1', tenantId: 'tenant-a', roles: ['seller'] },
  });
  const routeConfig = {
    createDependencies: (auth: any) => ({
      auth,
      data: base.data,
      events: base.events,
      audit: base.audit,
      logger: base.logger,
      time: base.time,
    }),
  } as unknown as RouteGeneratorConfig;

  const app = Fastify();
  apps.push(app);
  app.post('/echo', async (request) => ({ body: request.body }));
  registerPaymentRoutes(app, routeConfig, payments);
  await app.ready();

  const ledger = () => (base.data as any).PaymentProviderEvent.findMany({});
  return { app, fake, payments, base, ledger };
}

describe('registerPaymentRoutes', () => {
  it('verifies the exact raw bytes and records the event', async () => {
    const { app, fake, ledger } = await build();
    fake.accounts.set('acct_x', {
      id: 'acct_x',
      dashboard: 'full',
      feesCollector: 'provider',
      lossesCollector: 'provider',
      country: 'US',
      defaultCurrency: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      closed: false,
      livemode: false,
    });
    const delivery = fake.event('account', 'acct_x');
    // Re-serialize with spacing: a parse/re-stringify would change these bytes.
    const spaced = JSON.stringify(JSON.parse(delivery.rawBody.toString()), null, 2);
    const signature = createHmac('sha256', 'whsec_fake').update(spaced).digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/payments/webhooks/fake',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        [FAKE_SIGNATURE_HEADER]: signature,
      },
      payload: spaced,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ignored', ignoredReason: 'unknown_seller_account' });
  });

  it('leaves JSON parsing untouched on the rest of the app', async () => {
    const { app } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    expect(response.json()).toEqual({ body: { hello: 'world' } });
  });

  it('answers 400 to a bad signature and records nothing', async () => {
    const { app, ledger } = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/payments/webhooks/fake',
      headers: { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: 'nope' },
      payload: '{"id":"evt_1"}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_signature' } });
    expect(await ledger()).toHaveLength(0);
  });

  it('enforces the body limit and the configured path', async () => {
    const { app } = await build({ webhooks: { path: '/hooks/pay', bodyLimitBytes: 1024 } });
    const big = await app.inject({
      method: 'POST',
      url: '/hooks/pay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(2048) }),
    });
    expect(big.statusCode).toBe(413);
    const old = await app.inject({ method: 'POST', url: '/payments/webhooks/fake', payload: '{}' });
    expect(old.statusCode).toBe(404);
  });

  it('answers 500 when the event cannot be recorded, so the provider retries', async () => {
    const { app, fake, base } = await build();
    await createAccountRow(base);
    fake.accounts.set('acct_z', {
      id: 'acct_z',
      dashboard: 'full',
      feesCollector: 'provider',
      lossesCollector: 'provider',
      country: 'US',
      defaultCurrency: null,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      closed: false,
      livemode: false,
    });
    const repo = (base.data as any).PaymentProviderEvent;
    repo.create = async () => {
      throw new Error('database down');
    };
    const delivery = fake.event('account', 'acct_z');
    const response = await app.inject({
      method: 'POST',
      url: '/payments/webhooks/fake',
      headers: delivery.headers,
      payload: delivery.rawBody,
    });
    expect(response.statusCode).toBe(500);
  });
});

async function createAccountRow(base: any) {
  await base.data.PaymentMerchantAccount.create({
    tenantId: 'tenant-a',
    ownerType: 'user',
    ownerId: 'seller-1',
    provider: 'fake',
    providerAccountId: 'acct_z',
    dashboard: 'full',
    feesCollector: 'provider',
    lossesCollector: 'provider',
    status: 'active',
    chargesEnabled: true,
    payoutsEnabled: true,
    livemode: false,
  });
}
