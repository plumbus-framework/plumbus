import { afterEach, describe, expect, it } from 'vitest';
import { STRIPE_SNAPSHOT_EVENTS, STRIPE_THIN_EVENTS } from '../events.js';
import { STRIPE_API_VERSION, STRIPE_DESTINATION_NAMES, stripeProvider } from '../provider.js';
import { createStripeHttpStub } from '../testing/index.js';
import { list } from './fixtures.js';

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

function destination(overrides: Record<string, unknown>) {
  return {
    id: 'ed_1',
    object: 'v2.core.event_destination',
    name: STRIPE_DESTINATION_NAMES.snapshot,
    event_payload: 'snapshot',
    status: 'enabled',
    enabled_events: [...STRIPE_SNAPSHOT_EVENTS],
    events_from: ['@accounts'],
    snapshot_api_version: STRIPE_API_VERSION,
    webhook_endpoint: { url: 'https://app.test/payments/webhooks/stripe' },
    ...overrides,
  };
}

function setup(key = 'sk_test_1', secrets = ['whsec_1', 'whsec_2']) {
  const stub = createStripeHttpStub();
  const provider = stripeProvider({
    secretKey: key,
    webhookSecrets: secrets,
    httpClient: stub.httpClient,
    maxNetworkRetries: 0,
  });
  return { stub, provider };
}

describe('setupWebhooks', () => {
  it('creates a snapshot destination for sellers and a thin one for v2 accounts', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v2/core/event_destinations', () => ({ data: [], next_page_url: null }));
    let n = 0;
    stub.on('POST /v2/core/event_destinations', (request) => ({
      id: `ed_${++n}`,
      ...request.body,
      webhook_endpoint: { url: 'https://app.test/hook', signing_secret: `whsec_new_${n}` },
    }));

    const result = await provider.setupWebhooks?.({ url: 'https://app.test/hook' });
    expect(result?.destinations).toEqual([
      expect.objectContaining({ format: 'snapshot', secret: 'whsec_new_1', created: true }),
      expect.objectContaining({ format: 'thin', secret: 'whsec_new_2', created: true }),
    ]);
    const [snapshot, thin] = stub.requests.filter((r) => r.method === 'POST').map((r) => r.body);
    expect(snapshot).toMatchObject({
      name: STRIPE_DESTINATION_NAMES.snapshot,
      type: 'webhook_endpoint',
      event_payload: 'snapshot',
      events_from: ['@accounts'],
      snapshot_api_version: STRIPE_API_VERSION,
      enabled_events: [...STRIPE_SNAPSHOT_EVENTS],
      webhook_endpoint: { url: 'https://app.test/hook' },
      include: ['webhook_endpoint.signing_secret', 'webhook_endpoint.url'],
    });
    expect(thin).toMatchObject({
      name: STRIPE_DESTINATION_NAMES.thin,
      event_payload: 'thin',
      events_from: ['@self'],
      enabled_events: [...STRIPE_THIN_EVENTS],
    });
    expect(thin?.snapshot_api_version).toBeUndefined();
  });

  it('leaves existing destinations for the same URL alone', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v2/core/event_destinations', () =>
      list([
        destination({ webhook_endpoint: { url: 'https://app.test/hook' } }),
        destination({
          id: 'ed_2',
          name: STRIPE_DESTINATION_NAMES.thin,
          event_payload: 'thin',
          webhook_endpoint: { url: 'https://app.test/hook' },
        }),
      ]),
    );
    const result = await provider.setupWebhooks?.({ url: 'https://app.test/hook' });
    expect(result?.destinations.map((d) => d.created)).toEqual([false, false]);
    expect(stub.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('diagnose', () => {
  it('passes a correctly wired platform with only the restricted-key hint', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v2/core/accounts', () => ({ data: [], next_page_url: null }));
    stub.on('GET /v2/core/event_destinations', () =>
      list([
        destination({}),
        destination({
          id: 'ed_2',
          name: STRIPE_DESTINATION_NAMES.thin,
          event_payload: 'thin',
          enabled_events: [...STRIPE_THIN_EVENTS],
          snapshot_api_version: null,
        }),
      ]),
    );
    const findings = await provider.diagnose?.({
      webhookUrl: 'https://app.test/payments/webhooks/stripe',
    });
    expect(findings?.map((f) => f.code)).toEqual(['stripe_use_restricted_key']);
  });

  it('reports a test key in production, missing destinations, and a disabled Connect platform', async () => {
    process.env.NODE_ENV = 'production';
    const { stub, provider } = setup('rk_test_1', ['whsec_only']);
    stub.on('GET /v2/core/accounts', () => ({
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'accounts_v2_access_blocked',
          message: 'Accounts v2 is not enabled',
        },
      },
    }));
    stub.on('GET /v2/core/event_destinations', () => list([]));
    const codes = (await provider.diagnose?.({}))?.map((f) => f.code);
    expect(codes).toEqual([
      'stripe_test_key_in_production',
      'stripe_webhook_secrets_incomplete',
      'stripe_accounts_v2_unavailable',
      'stripe_snapshot_destination_missing',
      'stripe_thin_destination_missing',
    ]);
  });

  it('reports wrong URLs, missing events, disabled destinations, and version drift', async () => {
    const { stub, provider } = setup('rk_live_1');
    stub.on('GET /v2/core/accounts', () => ({ data: [], next_page_url: null }));
    stub.on('GET /v2/core/event_destinations', () =>
      list([
        destination({
          status: 'disabled',
          enabled_events: ['checkout.session.completed'],
          snapshot_api_version: '2025-03-31.basil',
          webhook_endpoint: { url: 'https://old.test/hook' },
        }),
        destination({
          id: 'ed_2',
          name: STRIPE_DESTINATION_NAMES.thin,
          event_payload: 'thin',
          enabled_events: [...STRIPE_THIN_EVENTS],
        }),
      ]),
    );
    const codes = (
      await provider.diagnose?.({ webhookUrl: 'https://app.test/payments/webhooks/stripe' })
    )?.map((f) => f.code);
    expect(codes).toEqual([
      'stripe_live_key_outside_production',
      'stripe_snapshot_destination_disabled',
      'stripe_snapshot_destination_url',
      'stripe_snapshot_destination_events',
      'stripe_snapshot_version_mismatch',
    ]);
  });
});
