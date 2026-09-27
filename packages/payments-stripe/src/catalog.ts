// ── The platform's billing catalog on Stripe ──
// `billing.plans` and `billing.meters` become Stripe objects found again by
// stable handles, so sync is idempotent and a check can say what is missing:
//  • one Product per plan and per meter, with an id derived from the namespace
//  • one Price per plan price and per meter, by lookup key; a changed amount
//    makes a new price that takes over the lookup key (existing subscribers keep
//    the old one), and the old price is archived
//  • one entitlement Feature per feature key (`plumbus:<namespace>:feature:<key>`),
//    attached to the products of the plans that grant it
//  • one billing Meter per meter, by event name

import { createHash } from 'node:crypto';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { CatalogInput, CatalogResult } from '@plumbus/payments';
import Stripe from 'stripe';
import { idOf } from './mapping.js';

/** Stripe filters prices by at most 10 lookup keys per request. */
const LOOKUP_KEYS_PER_REQUEST = 10;

export function featureLookupKey(namespace: string, feature: string): string {
  return `plumbus:${namespace}:feature:${feature}`;
}

/** Feature keys of this namespace's lookup keys; other keys are ignored. */
export function featureKeysOf(lookupKeys: readonly string[], namespace?: string): string[] {
  const keys: string[] = [];
  for (const lookupKey of lookupKeys) {
    const parts = lookupKey.split(':');
    if (parts.length < 4 || parts[0] !== 'plumbus' || parts[2] !== 'feature') continue;
    if (namespace !== undefined && parts[1] !== namespace) continue;
    keys.push(parts.slice(3).join(':'));
  }
  return keys;
}

/** Product id for a plan or meter: stable per namespace and key, valid as a Stripe id. */
export function catalogProductId(namespace: string, kind: 'plan' | 'meter', key: string): string {
  const digest = createHash('sha256').update(`${namespace}\u0000${kind}\u0000${key}`).digest('hex');
  return `plumbus_${kind}_${digest.slice(0, 24)}`;
}

export async function findPricesByLookupKey(
  stripe: Stripe,
  lookupKeys: readonly string[],
  options: Stripe.RequestOptions = {},
): Promise<Map<string, Stripe.Price>> {
  const found = new Map<string, Stripe.Price>();
  const unique = [...new Set(lookupKeys)];
  for (let i = 0; i < unique.length; i += LOOKUP_KEYS_PER_REQUEST) {
    const chunk = unique.slice(i, i + LOOKUP_KEYS_PER_REQUEST);
    const page = await stripe.prices.list(
      { lookup_keys: chunk, limit: LOOKUP_KEYS_PER_REQUEST },
      options,
    );
    for (const price of page.data) if (price.lookup_key) found.set(price.lookup_key, price);
  }
  return found;
}

function isMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { statusCode?: number }).statusCode === 404 &&
    (err as { code?: string }).code === 'resource_missing'
  );
}

async function retrieveProduct(stripe: Stripe, id: string): Promise<Stripe.Product | null> {
  try {
    return await stripe.products.retrieve(id);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

interface ProductWanted {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
}

/**
 * Bring the catalog to `input` (apply) or report what differs (check). The two
 * share one walk so a check lists exactly what a sync would do.
 */
export async function reconcileCatalog(
  stripe: Stripe,
  input: CatalogInput,
  apply: boolean,
): Promise<CatalogResult> {
  const changes: string[] = [];
  const prices: Record<string, string> = {};
  const ns = input.namespace;

  // Entitlement features.
  const featureIds = new Map<string, string>();
  for (const feature of input.features) {
    const lookupKey = featureLookupKey(ns, feature.key);
    const [found] = (await stripe.entitlements.features.list({ lookup_key: lookupKey, limit: 1 }))
      .data;
    if (!found) {
      changes.push(`create feature ${feature.key}`);
      if (apply) {
        const created = await stripe.entitlements.features.create({
          lookup_key: lookupKey,
          name: feature.name,
          metadata: { plumbus_catalog: ns, plumbus_feature: feature.key },
        });
        featureIds.set(feature.key, created.id);
      }
      continue;
    }
    featureIds.set(feature.key, found.id);
    if (found.name !== feature.name || !found.active) {
      changes.push(`update feature ${feature.key}`);
      if (apply)
        await stripe.entitlements.features.update(found.id, { name: feature.name, active: true });
    }
  }

  const ensureProduct = async (wanted: ProductWanted, label: string): Promise<boolean> => {
    const product = await retrieveProduct(stripe, wanted.id);
    if (!product) {
      changes.push(`create product ${label}`);
      if (apply) {
        await stripe.products.create({
          id: wanted.id,
          name: wanted.name,
          ...(wanted.description ? { description: wanted.description } : {}),
          metadata: wanted.metadata,
        });
      }
      return apply;
    }
    if (
      product.name !== wanted.name ||
      (product.description ?? null) !== wanted.description ||
      !product.active
    ) {
      changes.push(`update product ${label}`);
      if (apply) {
        await stripe.products.update(wanted.id, {
          name: wanted.name,
          description: wanted.description ?? '',
          active: true,
        });
      }
    }
    return true;
  };

  // Plan products and the features each grants.
  const planProducts = new Map<string, boolean>();
  for (const plan of input.plans) {
    const productId = catalogProductId(ns, 'plan', plan.key);
    const exists = await ensureProduct(
      {
        id: productId,
        name: plan.name,
        description: plan.description ?? null,
        metadata: { plumbus_catalog: ns, plumbus_plan: plan.key },
      },
      `plan ${plan.key}`,
    );
    planProducts.set(plan.key, exists);
    if (!exists) {
      for (const feature of plan.features) changes.push(`grant ${feature} with plan ${plan.key}`);
      continue;
    }
    const attached = (await stripe.products.listFeatures(productId, { limit: 100 })).data;
    const wanted = new Set(plan.features);
    for (const attachment of attached) {
      const key = featureKeysOf([attachment.entitlement_feature.lookup_key], ns)[0];
      if (key === undefined || wanted.has(key)) continue;
      changes.push(`stop granting ${key} with plan ${plan.key}`);
      if (apply) await stripe.products.deleteFeature(productId, attachment.id);
    }
    const have = new Set(
      attached.flatMap((a) => featureKeysOf([a.entitlement_feature.lookup_key], ns)),
    );
    for (const key of plan.features) {
      if (have.has(key)) continue;
      changes.push(`grant ${key} with plan ${plan.key}`);
      const featureId = featureIds.get(key);
      if (apply && featureId) {
        await stripe.products.createFeature(productId, { entitlement_feature: featureId });
      }
    }
  }

  // Meters, found by event name.
  const meters = new Map<string, Stripe.Billing.Meter>();
  if (input.meters.length > 0) {
    for (const meter of (await stripe.billing.meters.list({ status: 'active', limit: 100 })).data) {
      meters.set(meter.event_name, meter);
    }
  }
  const meterIds = new Map<string, string>();
  const meterProducts = new Map<string, boolean>();
  for (const meter of input.meters) {
    const found = meters.get(meter.eventName);
    if (!found) {
      changes.push(`create meter ${meter.key} (event ${meter.eventName})`);
      if (apply) {
        const created = await stripe.billing.meters.create({
          display_name: meter.name,
          event_name: meter.eventName,
          default_aggregation: { formula: meter.aggregation },
          customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
          value_settings: { event_payload_key: 'value' },
        });
        meterIds.set(meter.key, created.id);
      }
    } else {
      meterIds.set(meter.key, found.id);
      if (found.default_aggregation.formula !== meter.aggregation) {
        const message = `Meter ${meter.key} (event ${meter.eventName}) aggregates by ${found.default_aggregation.formula} at Stripe, not ${meter.aggregation}; Stripe cannot change a meter's aggregation, so use a new eventName`;
        if (apply) {
          throw new PlumbusError(ErrorCode.Validation, message, {
            reason: 'stripe_meter_aggregation_mismatch',
            meter: meter.key,
          });
        }
        changes.push(message);
      }
      if (found.display_name !== meter.name) {
        changes.push(`rename meter ${meter.key}`);
        if (apply) await stripe.billing.meters.update(found.id, { display_name: meter.name });
      }
    }
    meterProducts.set(
      meter.key,
      await ensureProduct(
        {
          id: catalogProductId(ns, 'meter', meter.key),
          name: meter.name,
          description: null,
          metadata: { plumbus_catalog: ns, plumbus_meter: meter.key },
        },
        `meter ${meter.key}`,
      ),
    );
  }

  // Prices, by lookup key.
  const existing = await findPricesByLookupKey(stripe, [
    ...input.plans.flatMap((plan) => plan.prices.map((price) => price.lookupKey)),
    ...input.meters.map((meter) => meter.lookupKey),
  ]);

  const ensurePrice = async (
    lookupKey: string,
    matches: (price: Stripe.Price) => boolean,
    create: Stripe.PriceCreateParams,
    label: string,
  ) => {
    const found = existing.get(lookupKey);
    if (found?.active && matches(found)) {
      prices[lookupKey] = found.id;
      return;
    }
    changes.push(found ? `replace price ${label}` : `create price ${label}`);
    if (!apply) {
      if (found) prices[lookupKey] = found.id;
      return;
    }
    const created = await stripe.prices.create({
      ...create,
      lookup_key: lookupKey,
      ...(found ? { transfer_lookup_key: true } : {}),
    });
    // New subscriptions take the new price; existing subscribers keep the old one.
    if (found?.active) await stripe.prices.update(found.id, { active: false });
    prices[lookupKey] = created.id;
  };

  for (const plan of input.plans) {
    const productId = catalogProductId(ns, 'plan', plan.key);
    for (const price of plan.prices) {
      const label = `${price.lookupKey} (${price.amount} ${price.currency} every ${price.intervalCount} ${price.interval})`;
      if (!planProducts.get(plan.key)) {
        changes.push(`create price ${label}`);
        continue;
      }
      await ensurePrice(
        price.lookupKey,
        (found) =>
          found.unit_amount === price.amount &&
          found.currency === price.currency &&
          found.recurring?.interval === price.interval &&
          (found.recurring?.interval_count ?? 1) === price.intervalCount &&
          found.recurring?.usage_type !== 'metered' &&
          idOf(found.product) === productId,
        {
          currency: price.currency,
          unit_amount: price.amount,
          recurring: { interval: price.interval, interval_count: price.intervalCount },
          product: productId,
          metadata: { plumbus_catalog: ns, plumbus_plan: plan.key, plumbus_price: price.key },
        },
        label,
      );
    }
  }

  for (const meter of input.meters) {
    const productId = catalogProductId(ns, 'meter', meter.key);
    const meterId = meterIds.get(meter.key);
    const label = `${meter.lookupKey} (${meter.unitAmountDecimal} ${meter.currency} per unit, every ${meter.interval})`;
    if (!meterId || !meterProducts.get(meter.key)) {
      changes.push(`create price ${label}`);
      continue;
    }
    await ensurePrice(
      meter.lookupKey,
      (found) =>
        found.unit_amount_decimal != null &&
        Stripe.Decimal.from(String(found.unit_amount_decimal)).eq(
          Stripe.Decimal.from(meter.unitAmountDecimal),
        ) &&
        found.currency === meter.currency &&
        found.recurring?.interval === meter.interval &&
        found.recurring?.usage_type === 'metered' &&
        found.recurring?.meter === meterId &&
        idOf(found.product) === productId,
      {
        currency: meter.currency,
        unit_amount_decimal: Stripe.Decimal.from(meter.unitAmountDecimal),
        recurring: { interval: meter.interval, usage_type: 'metered', meter: meterId },
        product: productId,
        metadata: { plumbus_catalog: ns, plumbus_meter: meter.key },
      },
      label,
    );
  }

  return { prices, changes };
}
