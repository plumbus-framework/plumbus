// ── Environment checks and webhook setup ──
// `plumbus payments doctor --live` and `plumbus payments webhooks setup`.

import type { CatalogInput, PaymentsFinding, WebhookSetupResult } from '@plumbus/payments';
import Stripe from 'stripe';
import { reconcileCatalog } from './catalog.js';
import {
  STRIPE_PLATFORM_SNAPSHOT_EVENTS,
  STRIPE_SNAPSHOT_EVENTS,
  STRIPE_SNAPSHOT_SOURCES,
  STRIPE_THIN_EVENTS,
} from './events.js';
import { keyMode } from './secrets.js';

export const STRIPE_API_VERSION = Stripe.API_VERSION;

export const STRIPE_DESTINATION_NAMES = {
  snapshot: 'plumbus-payments-sellers',
  thin: 'plumbus-payments-accounts',
} as const;

interface DestinationPlan {
  name: string;
  format: 'snapshot' | 'thin';
  events: readonly string[];
  sources: readonly string[];
}

const MARKETPLACE_PLANS: readonly DestinationPlan[] = [
  {
    name: STRIPE_DESTINATION_NAMES.snapshot,
    format: 'snapshot',
    events: STRIPE_SNAPSHOT_EVENTS,
    sources: STRIPE_SNAPSHOT_SOURCES,
  },
  {
    name: STRIPE_DESTINATION_NAMES.thin,
    format: 'thin',
    events: STRIPE_THIN_EVENTS,
    sources: ['@self'],
  },
];

/**
 * A platform without sellers (only `billing`) has no connected accounts: one
 * snapshot destination for its own events, no thin v2 account events, and no
 * need for Connect. It keeps the snapshot destination's name, so adding sellers
 * later shows up in doctor as a destination to replace rather than a silent
 * second one.
 */
const PLATFORM_PLANS: readonly DestinationPlan[] = [
  {
    name: STRIPE_DESTINATION_NAMES.snapshot,
    format: 'snapshot',
    events: STRIPE_PLATFORM_SNAPSHOT_EVENTS,
    sources: ['@self'],
  },
];

/** The destinations an app needs: with sellers (the default) or platform only. */
export function destinationPlans(sellers = true): readonly DestinationPlan[] {
  return sellers ? MARKETPLACE_PLANS : PLATFORM_PLANS;
}

type Destination = Stripe.V2.Core.EventDestination;

const hasSources = (destination: Destination, sources: readonly string[]) =>
  sources.every((source) => destination.events_from?.includes(source));

/** The destination doctor and setup look at: at the URL, with every source, when there is one. */
function pick(
  named: Destination[],
  plan: DestinationPlan,
  url: string | undefined,
): Destination | undefined {
  const atUrl = url ? named.filter((d) => d.webhook_endpoint?.url === url) : named;
  const pool = atUrl.length > 0 ? atUrl : named;
  return pool.find((d) => hasSources(d, plan.sources)) ?? pool[0];
}

export async function diagnoseStripe(input: {
  client: () => Promise<Stripe>;
  secretKey: () => Promise<string>;
  webhookSecrets: () => Promise<readonly string[]>;
  webhookUrl: string | undefined;
  catalog: CatalogInput | undefined;
  /** The config has sellers (default). Without them Connect is not needed. */
  sellers?: boolean;
}): Promise<PaymentsFinding[]> {
  const findings: PaymentsFinding[] = [];
  const sellers = input.sellers ?? true;
  const plans = destinationPlans(sellers);
  let key: string;
  try {
    key = await input.secretKey();
    const mode = keyMode(key);
    const production = process.env.NODE_ENV === 'production';
    if (production && mode === 'test') {
      findings.push({
        level: 'error',
        code: 'stripe_test_key_in_production',
        message: 'NODE_ENV is production but the Stripe key is a test key',
      });
    }
    if (!production && mode === 'live') {
      findings.push({
        level: 'warning',
        code: 'stripe_live_key_outside_production',
        message: 'A live Stripe key is configured outside production',
      });
    }
    if (key.startsWith('sk_')) {
      findings.push({
        level: 'info',
        code: 'stripe_use_restricted_key',
        message:
          'Consider a restricted key (rk_…) with only the permissions listed in docs/payments/stripe.md',
      });
    }
  } catch (err) {
    findings.push({ level: 'error', code: 'stripe_key_invalid', message: messageOf(err) });
    return findings;
  }

  try {
    const secrets = await input.webhookSecrets();
    if (secrets.length < plans.length) {
      findings.push({
        level: 'warning',
        code: 'stripe_webhook_secrets_incomplete',
        message:
          plans.length === 1
            ? 'The event destination signs deliveries with a secret; none configured'
            : `${plans.length} event destinations sign with separate secrets; ${secrets.length} configured`,
      });
    }
  } catch (err) {
    findings.push({
      level: 'error',
      code: 'stripe_webhook_secrets_missing',
      message: messageOf(err),
    });
  }

  const stripe = await input.client();
  // Sellers are v2 Accounts; a platform that only bills its own customers never makes one.
  if (sellers) {
    try {
      await stripe.v2.core.accounts.list({ limit: 1 });
    } catch (err) {
      findings.push({
        level: 'error',
        code: 'stripe_accounts_v2_unavailable',
        message: `Accounts v2 is not usable with this key: ${messageOf(err)}. Finish Connect onboarding (platform profile) and use a key with Connect access.`,
      });
    }
  }

  try {
    const destinations = (
      await stripe.v2.core.eventDestinations.list({ include: ['webhook_endpoint.url'], limit: 20 })
    ).data;
    for (const plan of plans) {
      const { format, name } = plan;
      const named = destinations.filter((d) => d.event_payload === format && d.name === name);
      const found = pick(named, plan, input.webhookUrl);
      if (found && named.length > 1) {
        findings.push({
          level: 'warning',
          code: `stripe_${format}_destination_duplicate`,
          message: `${named.length} event destinations are named "${name}"; Stripe sends events to each. Keep ${found.id} and delete ${named
            .filter((d) => d !== found)
            .map((d) => `${d.id} (${d.webhook_endpoint?.url ?? 'no url'})`)
            .join(', ')}`,
        });
      }
      if (!found) {
        findings.push({
          level: 'error',
          code: `stripe_${format}_destination_missing`,
          message: `No ${format} event destination "${name}"; run plumbus payments webhooks setup --url <your webhook URL>`,
        });
        continue;
      }
      if (found.status !== 'enabled') {
        findings.push({
          level: 'error',
          code: `stripe_${format}_destination_disabled`,
          message: `Event destination "${name}" is disabled`,
        });
      }
      if (input.webhookUrl && found.webhook_endpoint?.url !== input.webhookUrl) {
        findings.push({
          level: 'error',
          code: `stripe_${format}_destination_url`,
          message: `Event destination "${name}" points at ${found.webhook_endpoint?.url ?? '(none)'}, not ${input.webhookUrl}`,
        });
      }
      if (!hasSources(found, plan.sources)) {
        findings.push({
          level: 'error',
          code: `stripe_${format}_destination_sources`,
          message: `Event destination "${name}" takes events from ${(found.events_from ?? []).join(', ') || '(nothing)'}, not ${plan.sources.join(' and ')}; run plumbus payments webhooks setup again (Stripe cannot change the sources of a destination, so it makes a new one)`,
        });
      }
      const missing = plan.events.filter((type) => !found.enabled_events.includes(type));
      if (missing.length > 0) {
        findings.push({
          level: 'error',
          code: `stripe_${format}_destination_events`,
          message: `Event destination "${name}" is missing: ${missing.join(', ')}; run plumbus payments webhooks setup again`,
        });
      }
      if (
        format === 'snapshot' &&
        found.snapshot_api_version &&
        found.snapshot_api_version !== STRIPE_API_VERSION
      ) {
        findings.push({
          level: 'error',
          code: 'stripe_snapshot_version_mismatch',
          message: `Event destination "${name}" renders events as ${found.snapshot_api_version}; this package expects ${STRIPE_API_VERSION}`,
        });
      }
    }
  } catch (err) {
    findings.push({
      level: 'error',
      code: 'stripe_destinations_unreadable',
      message: `Could not list event destinations: ${messageOf(err)}`,
    });
  }

  if (input.catalog) {
    try {
      const { changes } = await reconcileCatalog(stripe, input.catalog, false);
      if (changes.length > 0) {
        findings.push({
          level: 'error',
          code: 'stripe_catalog_out_of_date',
          message: `The billing catalog at Stripe differs from billing in the config; run plumbus payments catalog sync. Differences: ${changes.join('; ')}`,
        });
      }
    } catch (err) {
      findings.push({
        level: 'error',
        code: 'stripe_catalog_unreadable',
        message: `Could not read the billing catalog: ${messageOf(err)}`,
      });
    }
  }
  return findings;
}

export async function setupStripeDestinations(
  stripe: Stripe,
  url: string,
  sellers = true,
): Promise<WebhookSetupResult> {
  const existing = (
    await stripe.v2.core.eventDestinations.list({ include: ['webhook_endpoint.url'], limit: 20 })
  ).data;
  const result: WebhookSetupResult = { destinations: [] };
  for (const plan of destinationPlans(sellers)) {
    const found = existing.find(
      (d) =>
        d.name === plan.name &&
        d.event_payload === plan.format &&
        d.webhook_endpoint?.url === url &&
        hasSources(d, plan.sources),
    );
    if (found) {
      // Newer releases act on more events: add them to the destination in place.
      const missing = plan.events.filter((type) => !found.enabled_events.includes(type));
      if (missing.length > 0) {
        await stripe.v2.core.eventDestinations.update(found.id, {
          enabled_events: [...new Set([...found.enabled_events, ...plan.events])],
        });
      }
      result.destinations.push({
        id: found.id,
        name: plan.name,
        format: plan.format,
        url,
        secret: null,
        created: false,
      });
      continue;
    }
    const created = await stripe.v2.core.eventDestinations.create({
      name: plan.name,
      description: 'Created by @plumbus/payments-stripe',
      type: 'webhook_endpoint',
      event_payload: plan.format,
      events_from: [...plan.sources],
      enabled_events: [...plan.events],
      ...(plan.format === 'snapshot' ? { snapshot_api_version: STRIPE_API_VERSION } : {}),
      webhook_endpoint: { url },
      include: ['webhook_endpoint.signing_secret', 'webhook_endpoint.url'],
    });
    result.destinations.push({
      id: created.id,
      name: plan.name,
      format: plan.format,
      url,
      secret: created.webhook_endpoint?.signing_secret ?? null,
      created: true,
    });
  }
  return result;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
