// The platform's own billing on Stripe: catalog sync and check against a
// stateful stub of Stripe's catalog, usage meter events, entitlements, billing
// customers, and the customer portal.

import type { CatalogInput } from '@plumbus/payments';
import { describe, expect, it } from 'vitest';
import { catalogProductId, featureLookupKey } from '../catalog.js';
import { stripeProvider } from '../provider.js';
import { createStripeHttpStub, type StripeHttpStub } from '../testing/index.js';
import { list } from './fixtures.js';

const catalog: CatalogInput = {
  namespace: 'myapp',
  plans: [
    {
      key: 'team',
      name: 'Team',
      description: 'For small teams',
      features: ['projects', 'ai'],
      prices: [
        {
          key: 'monthly',
          lookupKey: 'plumbus:myapp:team:monthly',
          amount: 1500,
          currency: 'usd',
          interval: 'month',
          intervalCount: 1,
          perSeat: true,
        },
      ],
    },
  ],
  meters: [
    {
      key: 'aiTokens',
      lookupKey: 'plumbus:myapp:meter:aiTokens',
      name: 'AI tokens',
      eventName: 'ai_tokens',
      aggregation: 'sum',
      unitAmountDecimal: '0.002',
      currency: 'usd',
      interval: 'month',
    },
  ],
  features: [
    { key: 'ai', name: 'AI assistant' },
    { key: 'projects', name: 'Projects' },
  ],
};

const team = catalog.plans[0] as CatalogInput['plans'][number];
const teamMonthly = team.prices[0] as CatalogInput['plans'][number]['prices'][number];

type Row = Record<string, unknown> & { id: string };

/** Stripe's catalog objects, kept in memory and changed by the requests the adapter sends. */
function fakeCatalog(stub: StripeHttpStub) {
  const products = new Map<string, Row>();
  const features = new Map<string, Row>();
  const attachments = new Map<string, Row[]>();
  const meters = new Map<string, Row>();
  const prices = new Map<string, Row>();
  let n = 0;
  const missing = (what: string) => ({
    status: 404,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `No such ${what}`,
      },
    },
  });
  const idIn = (path: string, index: number) => path.split('/')[index] as string;
  const keysIn = (query: URLSearchParams) =>
    [...query.entries()].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v);

  stub
    .on('GET /v1/entitlements/features', (r) =>
      list([...features.values()].filter((f) => f.lookup_key === r.query.get('lookup_key'))),
    )
    .on('POST /v1/entitlements/features', (r) => {
      const feature = {
        id: `feat_${++n}`,
        object: 'entitlements.feature',
        active: true,
        lookup_key: r.body.lookup_key,
        name: r.body.name,
      };
      features.set(feature.id, feature);
      return feature;
    })
    .on('POST /v1/entitlements/features/*', (r) => {
      const feature = features.get(idIn(r.path, 4)) as Row;
      Object.assign(feature, { name: r.body.name, active: r.body.active === 'true' });
      return feature;
    })
    .on('GET /v1/products/*/features', (r) => list(attachments.get(idIn(r.path, 3)) ?? []))
    .on('POST /v1/products/*/features', (r) => {
      const productId = idIn(r.path, 3);
      const attachment = {
        id: `pf_${++n}`,
        object: 'product_feature',
        entitlement_feature: features.get(String(r.body.entitlement_feature)),
      };
      attachments.set(productId, [...(attachments.get(productId) ?? []), attachment]);
      return attachment;
    })
    .on('DELETE /v1/products/*/features/*', (r) => {
      const productId = idIn(r.path, 3);
      attachments.set(
        productId,
        (attachments.get(productId) ?? []).filter((a) => a.id !== idIn(r.path, 5)),
      );
      return { id: idIn(r.path, 5), deleted: true };
    })
    .on('GET /v1/products/*', (r) => products.get(idIn(r.path, 3)) ?? missing('product'))
    .on('POST /v1/products', (r) => {
      const product = {
        id: String(r.body.id),
        object: 'product',
        name: r.body.name,
        description: r.body.description ?? null,
        active: true,
      };
      products.set(product.id, product);
      return product;
    })
    .on('POST /v1/products/*', (r) => {
      const product = products.get(idIn(r.path, 3)) as Row;
      Object.assign(product, {
        name: r.body.name,
        description: r.body.description || null,
        active: true,
      });
      return product;
    })
    .on('GET /v1/billing/meters', () => list([...meters.values()]))
    .on('POST /v1/billing/meters', (r) => {
      const meter = {
        id: `mtr_${++n}`,
        object: 'billing.meter',
        display_name: r.body.display_name,
        event_name: r.body.event_name,
        default_aggregation: { formula: r.body['default_aggregation[formula]'] },
        status: 'active',
      };
      meters.set(meter.id, meter);
      return meter;
    })
    .on('POST /v1/billing/meters/*', (r) => {
      const meter = meters.get(idIn(r.path, 4)) as Row;
      meter.display_name = r.body.display_name;
      return meter;
    })
    .on('GET /v1/prices', (r) => {
      const wanted = keysIn(r.query);
      return list([...prices.values()].filter((p) => wanted.includes(String(p.lookup_key))));
    })
    .on('POST /v1/prices', (r) => {
      const key = r.body.lookup_key;
      if (r.body.transfer_lookup_key === 'true') {
        for (const p of prices.values()) if (p.lookup_key === key) p.lookup_key = null;
      }
      const created = {
        id: `price_${++n}`,
        object: 'price',
        active: true,
        currency: r.body.currency,
        lookup_key: key,
        unit_amount: r.body.unit_amount ? Number(r.body.unit_amount) : null,
        unit_amount_decimal: r.body.unit_amount_decimal ?? r.body.unit_amount,
        product: r.body.product,
        recurring: {
          interval: r.body['recurring[interval]'],
          interval_count: Number(r.body['recurring[interval_count]'] ?? 1),
          usage_type: r.body['recurring[usage_type]'] ?? 'licensed',
          meter: r.body['recurring[meter]'] ?? null,
        },
      };
      prices.set(created.id, created);
      return created;
    })
    .on('POST /v1/prices/*', (r) => {
      const found = prices.get(idIn(r.path, 3)) as Row;
      found.active = r.body.active === 'true';
      return found;
    });
  return { products, features, attachments, meters, prices };
}

function setup() {
  const stub = createStripeHttpStub();
  const provider = stripeProvider({
    secretKey: 'sk_test_billing',
    webhookSecrets: ['whsec_1', 'whsec_2'],
    maxNetworkRetries: 0,
    httpClient: stub.httpClient,
  });
  return { stub, provider };
}

const writes = (stub: StripeHttpStub) =>
  stub.requests.filter((r) => r.method === 'POST' || r.method === 'DELETE');

describe('catalog sync', () => {
  it('creates features, products, meters, and prices, then finds them all again', async () => {
    const { stub, provider } = setup();
    const state = fakeCatalog(stub);

    const first = await provider.syncCatalog?.(catalog);
    const teamProduct = catalogProductId('myapp', 'plan', 'team');
    expect(state.products.get(teamProduct)).toMatchObject({
      name: 'Team',
      description: 'For small teams',
    });
    expect([...state.features.values()].map((f) => f.lookup_key).sort()).toEqual([
      featureLookupKey('myapp', 'ai'),
      featureLookupKey('myapp', 'projects'),
    ]);
    expect(state.attachments.get(teamProduct)).toHaveLength(2);
    expect([...state.meters.values()]).toEqual([
      expect.objectContaining({ event_name: 'ai_tokens', default_aggregation: { formula: 'sum' } }),
    ]);
    const meterPrice = [...state.prices.values()].find(
      (p) => p.lookup_key === 'plumbus:myapp:meter:aiTokens',
    );
    expect(meterPrice).toMatchObject({
      unit_amount_decimal: '0.002',
      recurring: expect.objectContaining({
        usage_type: 'metered',
        meter: [...state.meters.keys()][0],
      }),
      product: catalogProductId('myapp', 'meter', 'aiTokens'),
    });
    expect(Object.keys(first?.prices ?? {}).sort()).toEqual([
      'plumbus:myapp:meter:aiTokens',
      'plumbus:myapp:team:monthly',
    ]);
    expect(first?.changes.length).toBeGreaterThan(0);

    const before = writes(stub).length;
    const second = await provider.syncCatalog?.(catalog);
    expect(second?.changes).toEqual([]);
    expect(second?.prices).toEqual(first?.prices);
    expect(writes(stub).length).toBe(before);
  });

  it('moves the lookup key to a new price when the amount changes and archives the old one', async () => {
    const { stub, provider } = setup();
    const state = fakeCatalog(stub);
    const first = await provider.syncCatalog?.(catalog);
    const oldPrice = first?.prices['plumbus:myapp:team:monthly'] as string;

    const raised: CatalogInput = {
      ...catalog,
      plans: [{ ...team, prices: [{ ...teamMonthly, amount: 1900 }] }],
    };
    const second = await provider.syncCatalog?.(raised);
    const newPrice = second?.prices['plumbus:myapp:team:monthly'];
    expect(newPrice).not.toBe(oldPrice);
    expect(second?.changes).toEqual([
      expect.stringContaining('replace price plumbus:myapp:team:monthly'),
    ]);
    expect(state.prices.get(oldPrice)).toMatchObject({ active: false, lookup_key: null });
    expect(state.prices.get(newPrice as string)).toMatchObject({ unit_amount: 1900, active: true });
  });

  it('stops granting a feature a plan no longer lists', async () => {
    const { stub, provider } = setup();
    const state = fakeCatalog(stub);
    await provider.syncCatalog?.(catalog);
    const fewer: CatalogInput = {
      ...catalog,
      plans: [{ ...team, features: ['projects'] }],
    };
    const result = await provider.syncCatalog?.(fewer);
    expect(result?.changes).toEqual(['stop granting ai with plan team']);
    const granted = state.attachments.get(catalogProductId('myapp', 'plan', 'team')) ?? [];
    expect(granted.map((a) => (a.entitlement_feature as Row).lookup_key)).toEqual([
      featureLookupKey('myapp', 'projects'),
    ]);
  });

  it('checks without writing and lists what a sync would do', async () => {
    const { stub, provider } = setup();
    fakeCatalog(stub);
    const result = await provider.checkCatalog?.(catalog);
    expect(writes(stub)).toEqual([]);
    expect(result?.changes).toEqual(
      expect.arrayContaining([
        'create feature ai',
        'create product plan team',
        'create meter aiTokens (event ai_tokens)',
        expect.stringContaining('create price plumbus:myapp:team:monthly'),
      ]),
    );
    expect(result?.prices).toEqual({});
  });

  it('refuses to sync a meter whose aggregation Stripe cannot change', async () => {
    const { stub, provider } = setup();
    const state = fakeCatalog(stub);
    await provider.syncCatalog?.(catalog);
    const meter = [...state.meters.values()][0] as Row;
    meter.default_aggregation = { formula: 'count' };
    await expect(provider.syncCatalog?.(catalog)).rejects.toThrow('cannot change a meter');
    const check = await provider.checkCatalog?.(catalog);
    expect(check?.changes).toEqual([
      expect.stringContaining('aggregates by count at Stripe, not sum'),
    ]);
  });

  it('reports an out-of-date catalog from doctor', async () => {
    const { stub, provider } = setup();
    fakeCatalog(stub);
    stub.on('GET /v2/core/accounts', () => ({ data: [], next_page_url: null }));
    stub.on('GET /v2/core/event_destinations', () => list([]));
    const findings = await provider.diagnose?.({ catalog });
    expect(findings?.find((f) => f.code === 'stripe_catalog_out_of_date')?.message).toContain(
      'run plumbus payments catalog sync',
    );
  });
});

describe('usage, entitlements, customers, and the portal', () => {
  it('records usage as a meter event with its identifier', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/billing/meter_events', () => ({ object: 'billing.meter_event' }));
    await provider.recordUsage?.({
      customerId: 'cus_1',
      eventName: 'ai_tokens',
      value: 1234,
      identifier: 'plumbus-ai:cost-1',
      timestamp: new Date(1_790_000_000_000),
    });
    expect(stub.requests[0]?.body).toMatchObject({
      event_name: 'ai_tokens',
      'payload[stripe_customer_id]': 'cus_1',
      'payload[value]': '1234',
      identifier: 'plumbus-ai:cost-1',
      timestamp: '1790000000',
    });
  });

  it('lists active entitlements as feature keys, from the summary event too', async () => {
    const { stub, provider } = setup();
    stub.on('GET /v1/entitlements/active_entitlements', () =>
      list([
        {
          id: 'ent_1',
          object: 'entitlements.active_entitlement',
          feature: 'feat_1',
          lookup_key: featureLookupKey('myapp', 'ai'),
        },
        {
          id: 'ent_2',
          object: 'entitlements.active_entitlement',
          feature: 'feat_2',
          lookup_key: 'someone-elses-feature',
        },
      ]),
    );
    expect(await provider.listEntitlements?.({ customerId: 'cus_1' })).toEqual(['ai']);
    expect(
      await provider.resolveEvent({
        eventId: 'e',
        type: 'entitlements.active_entitlement_summary.updated',
        format: 'snapshot',
        livemode: false,
        accountId: null,
        objectId: 'cus_1',
        objectType: 'entitlements.active_entitlement_summary',
      }),
    ).toEqual([{ kind: 'entitlements', customerId: 'cus_1', features: ['ai'] }]);
  });

  it('creates billing customers on the platform', async () => {
    const { stub, provider } = setup();
    stub.on('POST /v1/customers', () => ({ id: 'cus_bill', object: 'customer' }));
    expect(
      await provider.createBillingCustomer?.({
        email: 'owner@acme.test',
        metadata: { plumbus_tenant_id: 't1' },
        idempotencyKey: 'plumbus-billing-customer:1',
      }),
    ).toEqual({ customerId: 'cus_bill' });
    expect(stub.requests[0]?.headers['stripe-account']).toBeUndefined();
  });

  it("makes a portal configuration once for an account that has none, and uses an account's default", async () => {
    const { stub, provider } = setup();
    let listed = 0;
    stub.on('GET /v1/billing_portal/configurations', (r) => {
      listed += 1;
      // The seller has none; the platform has a default.
      if (r.headers['stripe-account']) return list([]);
      return r.query.get('is_default') === 'true' ? list([{ id: 'bpc_default' }]) : list([]);
    });
    stub.on('POST /v1/billing_portal/configurations', () => ({
      id: 'bpc_new',
      object: 'billing_portal.configuration',
    }));
    stub.on('POST /v1/billing_portal/sessions', () => ({
      url: 'https://billing.stripe.com/p/session/1',
    }));

    const open = (sellerAccountId: string | null) =>
      provider.createPortalSession?.({
        sellerAccountId,
        clientId: 'cus_1',
        returnUrl: 'https://app.test/account',
      });
    await open('acct_seller');
    await open('acct_seller');
    await open(null);

    const creates = stub.requests.filter(
      (r) => r.path === '/v1/billing_portal/configurations' && r.method === 'POST',
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.headers['stripe-account']).toBe('acct_seller');
    const sessions = stub.requests.filter((r) => r.path === '/v1/billing_portal/sessions');
    expect(sessions.map((r) => r.body.configuration)).toEqual(['bpc_new', 'bpc_new', undefined]);
    expect(listed).toBe(3);
  });
});
