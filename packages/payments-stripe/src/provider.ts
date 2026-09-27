// ── stripeProvider() ──
// Stripe Connect adapter for @plumbus/payments, on Stripe's newest APIs:
// sellers are Accounts v2 (merchant configuration), charges are direct charges
// through Checkout on the seller's account, and account changes arrive as thin
// v2 events while payment events arrive as snapshot events.

import type {
  MerchantComponent,
  PaymentProvider,
  PaymentsFinding,
  ProviderStateChange,
  StoredProviderEvent,
  WebhookSetupResult,
} from '@plumbus/payments';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import Stripe from 'stripe';
import { stripeDefaultResponsibilities, validateStripeConfig } from './config-rules.js';
import {
  isRelevantStripeEvent,
  STRIPE_SNAPSHOT_EVENTS,
  STRIPE_THIN_EVENTS,
  verifyStripeWebhook,
} from './events.js';
import {
  fromResponsibility,
  mapAccount,
  mapDispute,
  mapRefund,
  mapSession,
  type StripeAccountLike,
  type StripeDisputeLike,
  type StripeRefundLike,
  type StripeSessionLike,
} from './mapping.js';
import { withStripeErrors } from './errors.js';
import { keyMode, lazySecret, type SecretSource } from './secrets.js';

/** The Stripe API version this package is built and tested against. */
export const STRIPE_API_VERSION = Stripe.API_VERSION;

export const STRIPE_DESTINATION_NAMES = {
  snapshot: 'plumbus-payments-sellers',
  thin: 'plumbus-payments-accounts',
} as const;

const ACCOUNT_INCLUDE = ['configuration.merchant', 'defaults', 'identity', 'requirements'] as const;

export interface StripeProviderOptions {
  /** Secret (`sk_…`) or restricted (`rk_…`) key, or a function returning it. */
  secretKey: SecretSource<string>;
  /** Signing secrets of every event destination (and old ones during a rotation). */
  webhookSecrets: SecretSource<readonly string[]>;
  /** Publishable key returned with merchant sessions for embedded components. */
  publishableKey?: string;
  /** Seconds a signature timestamp may be old (default 300, Stripe's default). */
  webhookToleranceSeconds?: number;
  /** Automatic retries on network errors and 409/429/5xx (default 2). */
  maxNetworkRetries?: number;
  /** Request timeout in milliseconds (default Stripe's 80 000). */
  timeoutMs?: number;
  /** Advanced: point the SDK at another host, e.g. stripe-mock (`localhost`, 12111, http). */
  api?: { host?: string; port?: number; protocol?: 'http' | 'https' };
  /** Advanced/testing: a custom HTTP client (see @plumbus/payments-stripe/testing). */
  httpClient?: Stripe.HttpClient;
}

export interface StripePaymentProvider extends PaymentProvider {
  /** The configured Stripe client, for Stripe-only features the neutral API does not cover. */
  client(): Promise<Stripe>;
}

// Checkout accepts expires_at 30 minutes to 24 hours after Stripe creates the
// session; keep a minute inside both ends for request time and clock skew.
const CHECKOUT_MIN_SECONDS = 31 * 60;
const CHECKOUT_MAX_SECONDS = 24 * 3600 - 60;
const PRODUCT_NAME_MAX = 250;

/** Cut to `max` UTF-16 units without splitting a surrogate pair (Stripe rejects half emoji). */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function checkoutExpiry(requested: Date): number {
  const now = Math.floor(Date.now() / 1000);
  const wanted = Math.floor(requested.getTime() / 1000);
  return Math.min(Math.max(wanted, now + CHECKOUT_MIN_SECONDS), now + CHECKOUT_MAX_SECONDS);
}

const COMPONENT_MAP: Record<MerchantComponent, string> = {
  onboarding: 'account_onboarding',
  account: 'account_management',
  notifications: 'notification_banner',
  payments: 'payments',
  payouts: 'payouts',
  balances: 'balances',
  disputes: 'disputes_list',
  documents: 'documents',
};

export function stripeProvider(options: StripeProviderOptions): StripePaymentProvider {
  const secretKey = lazySecret(options.secretKey, 'Stripe secret key');
  const webhookSecrets = lazySecret(options.webhookSecrets, 'Stripe webhook secrets');
  const tolerance = options.webhookToleranceSeconds ?? 300;
  let clientPromise: Promise<Stripe> | undefined;

  function client(): Promise<Stripe> {
    clientPromise ??= secretKey()
      .then((key) => {
        keyMode(key);
        return new Stripe(key, {
          apiVersion: STRIPE_API_VERSION,
          maxNetworkRetries: options.maxNetworkRetries ?? 2,
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
          ...(options.httpClient ? { httpClient: options.httpClient } : {}),
          ...(options.api?.host ? { host: options.api.host } : {}),
          ...(options.api?.port ? { port: options.api.port } : {}),
          ...(options.api?.protocol ? { protocol: options.api.protocol } : {}),
          appInfo: {
            name: '@plumbus/payments-stripe',
            url: 'https://github.com/plumbus-framework/plumbus',
          },
        });
      })
      .catch((err) => {
        clientPromise = undefined;
        throw err;
      });
    return clientPromise;
  }

  async function retrieveAccount(accountId: string) {
    const stripe = await client();
    const account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: [...ACCOUNT_INCLUDE],
    });
    return mapAccount(account as unknown as StripeAccountLike);
  }

  async function sessionForPayment(accountId: string, paymentIntentId: string) {
    const stripe = await client();
    const sessions = await stripe.checkout.sessions.list(
      { payment_intent: paymentIntentId, limit: 1, expand: ['data.payment_intent.latest_charge'] },
      { stripeAccount: accountId },
    );
    const session = sessions.data[0];
    return session ? mapSession(session as unknown as StripeSessionLike) : null;
  }

  async function paymentChangesFor(
    accountId: string,
    paymentIntentId: string | null,
  ): Promise<{ changes: ProviderStateChange[]; reference: string | null }> {
    if (!paymentIntentId) return { changes: [], reference: null };
    const charge = await sessionForPayment(accountId, paymentIntentId);
    if (!charge) return { changes: [], reference: null };
    return { changes: [{ kind: 'charge', accountId, charge }], reference: charge.reference };
  }

  const provider: StripePaymentProvider = {
    id: 'stripe',
    displayName: 'Stripe',
    client,

    defaultResponsibilities: stripeDefaultResponsibilities,
    validateConfig: validateStripeConfig,

    async resolveLivemode() {
      return keyMode(await secretKey()) === 'live';
    },
    isRelevantEvent(event) {
      return isRelevantStripeEvent(event.type);
    },

    createMerchantAccount: withStripeErrors(async (input) => {
      const stripe = await client();
      const account = await stripe.v2.core.accounts.create(
        {
          dashboard: input.dashboard,
          ...(input.email ? { contact_email: input.email } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
          identity: { country: input.country.toLowerCase() },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
          defaults: {
            ...(input.defaultCurrency ? { currency: input.defaultCurrency } : {}),
            responsibilities: {
              fees_collector: fromResponsibility(input.feesCollector),
              losses_collector: fromResponsibility(input.lossesCollector),
            },
          },
          metadata: input.metadata,
          include: [...ACCOUNT_INCLUDE],
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return mapAccount(account as unknown as StripeAccountLike);
    }),

    retrieveMerchantAccount: withStripeErrors(retrieveAccount),

    createOnboardingLink: withStripeErrors(async (input) => {
      const stripe = await client();
      const link = await stripe.v2.core.accountLinks.create({
        account: input.accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            configurations: ['merchant'],
            refresh_url: input.refreshUrl,
            return_url: input.returnUrl,
            collection_options: {
              fields: input.collectEventuallyDue ? 'eventually_due' : 'currently_due',
            },
          },
        },
      });
      return { url: link.url, expiresAt: new Date(link.expires_at) };
    }),

    createMerchantSession: withStripeErrors(async (input) => {
      const stripe = await client();
      const components: Record<string, unknown> = {};
      for (const component of input.components) {
        const key = COMPONENT_MAP[component];
        if (component === 'payments' || component === 'disputes') {
          components[key] = {
            enabled: true,
            features: {
              refund_management: input.allowRefunds,
              dispute_management: input.allowDisputeManagement,
              capture_payments: false,
            },
          };
        } else {
          components[key] = { enabled: true };
        }
      }
      const session = await stripe.accountSessions.create({
        account: input.accountId,
        components: components as Stripe.AccountSessionCreateParams.Components,
      });
      return {
        clientSecret: session.client_secret,
        expiresAt: new Date(session.expires_at * 1000),
        publishableKey: options.publishableKey ?? null,
      };
    }),

    createDashboardLink: withStripeErrors(async (input) => {
      if (input.dashboard === 'full') {
        // Full-dashboard sellers sign in to their own Stripe account.
        return { url: 'https://dashboard.stripe.com/' };
      }
      if (input.dashboard === 'express') {
        const stripe = await client();
        const link = await stripe.accounts.createLoginLink(input.accountId);
        return { url: link.url };
      }
      throw new PlumbusError(ErrorCode.Conflict, 'This seller has no Stripe dashboard', {
        reason: 'stripe_no_dashboard',
      });
    }),

    createClient: withStripeErrors(async (input) => {
      const stripe = await client();
      const customer = await stripe.customers.create(
        {
          ...(input.email ? { email: input.email } : {}),
          ...(input.name ? { name: input.name } : {}),
          metadata: input.metadata,
        },
        { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
      );
      return { clientId: customer.id };
    }),

    createCharge: withStripeErrors(async (input) => {
      const stripe = await client();
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: input.amount,
                product_data: { name: clip(input.description, PRODUCT_NAME_MAX) },
              },
            },
          ],
          ...(input.clientId ? { customer: input.clientId } : {}),
          ...(input.clientEmail && !input.clientId ? { customer_email: input.clientEmail } : {}),
          client_reference_id: input.reference,
          metadata: input.metadata,
          payment_intent_data: {
            ...(input.platformFeeAmount > 0
              ? { application_fee_amount: input.platformFeeAmount }
              : {}),
            description: input.description,
            metadata: input.metadata,
          },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: checkoutExpiry(input.expiresAt),
        },
        { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
      );
      return mapSession(session as unknown as StripeSessionLike);
    }),

    createRefund: withStripeErrors(async (input) => {
      const stripe = await client();
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.paymentId,
          ...(input.amount ? { amount: input.amount } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          refund_application_fee: input.refundPlatformFee,
          metadata: input.metadata,
        },
        { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
      );
      return mapRefund(refund as unknown as StripeRefundLike);
    }),

    async verifyWebhook({ rawBody, headers }) {
      return verifyStripeWebhook({
        rawBody,
        headers,
        secrets: await webhookSecrets(),
        toleranceSeconds: tolerance,
      });
    },

    resolveEvent: withStripeErrors(
      async (event: StoredProviderEvent): Promise<ProviderStateChange[]> => {
        const accountId = event.accountId;
        const objectId = event.objectId;
        if (!accountId || !objectId) return [];

        if (event.format === 'thin' && event.objectType === 'v2.core.account') {
          return [{ kind: 'merchant', account: await retrieveAccount(objectId) }];
        }

        const stripe = await client();
        const onSeller = { stripeAccount: accountId };

        if (event.type.startsWith('checkout.session.')) {
          const session = await stripe.checkout.sessions.retrieve(
            objectId,
            { expand: ['payment_intent.latest_charge'] },
            onSeller,
          );
          return [
            {
              kind: 'charge',
              accountId,
              charge: mapSession(session as unknown as StripeSessionLike),
            },
          ];
        }

        if (event.type === 'charge.refunded' || event.type === 'charge.refund.updated') {
          const refunds =
            event.objectType === 'refund'
              ? [await stripe.refunds.retrieve(objectId, {}, onSeller)]
              : (await stripe.refunds.list({ charge: objectId, limit: 100 }, onSeller)).data;
          const paymentId = refunds[0]
            ? mapRefund(refunds[0] as unknown as StripeRefundLike).paymentId
            : null;
          // The charge first: refunds are matched by the payment id it records.
          const { changes, reference } = await paymentChangesFor(accountId, paymentId);
          for (const refund of refunds) {
            changes.push({
              kind: 'refund',
              accountId,
              chargeReference: reference,
              refund: mapRefund(refund as unknown as StripeRefundLike),
            });
          }
          return changes;
        }

        if (event.type.startsWith('refund.')) {
          const refund = mapRefund(
            (await stripe.refunds.retrieve(objectId, {}, onSeller)) as unknown as StripeRefundLike,
          );
          const { changes, reference } = await paymentChangesFor(accountId, refund.paymentId);
          return [...changes, { kind: 'refund', accountId, chargeReference: reference, refund }];
        }

        if (event.type.startsWith('charge.dispute.')) {
          const dispute = mapDispute(
            (await stripe.disputes.retrieve(
              objectId,
              {},
              onSeller,
            )) as unknown as StripeDisputeLike,
          );
          const { changes, reference } = await paymentChangesFor(accountId, dispute.paymentId);
          return [...changes, { kind: 'dispute', accountId, chargeReference: reference, dispute }];
        }

        return [];
      },
    ),

    async diagnose({ webhookUrl } = {}) {
      return diagnoseStripe({ client, secretKey, webhookSecrets, webhookUrl });
    },

    setupWebhooks: withStripeErrors(async ({ url }: { url: string }) =>
      setupStripeDestinations(await client(), url),
    ),
  };
  return provider;
}

// ── Environment checks (plumbus payments doctor --live) ──

async function diagnoseStripe(input: {
  client: () => Promise<Stripe>;
  secretKey: () => Promise<string>;
  webhookSecrets: () => Promise<readonly string[]>;
  webhookUrl: string | undefined;
}): Promise<PaymentsFinding[]> {
  const findings: PaymentsFinding[] = [];
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
    if (secrets.length < 2) {
      findings.push({
        level: 'warning',
        code: 'stripe_webhook_secrets_incomplete',
        message: `Two event destinations sign with separate secrets; ${secrets.length} configured`,
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
  try {
    await stripe.v2.core.accounts.list({ limit: 1 });
  } catch (err) {
    findings.push({
      level: 'error',
      code: 'stripe_accounts_v2_unavailable',
      message: `Accounts v2 is not usable with this key: ${messageOf(err)}. Finish Connect onboarding (platform profile) and use a key with Connect access.`,
    });
  }

  try {
    const destinations = (
      await stripe.v2.core.eventDestinations.list({ include: ['webhook_endpoint.url'], limit: 20 })
    ).data;
    for (const [format, name, required] of [
      ['snapshot', STRIPE_DESTINATION_NAMES.snapshot, STRIPE_SNAPSHOT_EVENTS],
      ['thin', STRIPE_DESTINATION_NAMES.thin, STRIPE_THIN_EVENTS],
    ] as const) {
      const named = destinations.filter((d) => d.event_payload === format && d.name === name);
      // After a URL change the old destination can still exist; check the one at the URL.
      const found =
        named.find((d) => input.webhookUrl && d.webhook_endpoint?.url === input.webhookUrl) ??
        named[0];
      if (found && named.length > 1) {
        findings.push({
          level: 'warning',
          code: `stripe_${format}_destination_duplicate`,
          message: `${named.length} event destinations are named "${name}"; Stripe sends events to each. Delete the ones at ${named
            .filter((d) => d !== found)
            .map((d) => d.webhook_endpoint?.url ?? '(no url)')
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
      const missing = required.filter((type) => !found.enabled_events.includes(type));
      if (missing.length > 0) {
        findings.push({
          level: 'error',
          code: `stripe_${format}_destination_events`,
          message: `Event destination "${name}" is missing: ${missing.join(', ')}`,
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
  return findings;
}

async function setupStripeDestinations(stripe: Stripe, url: string): Promise<WebhookSetupResult> {
  const existing = (
    await stripe.v2.core.eventDestinations.list({ include: ['webhook_endpoint.url'], limit: 20 })
  ).data;
  const plans = [
    {
      name: STRIPE_DESTINATION_NAMES.snapshot,
      format: 'snapshot' as const,
      events: [...STRIPE_SNAPSHOT_EVENTS],
      eventsFrom: ['@accounts'],
    },
    {
      name: STRIPE_DESTINATION_NAMES.thin,
      format: 'thin' as const,
      events: [...STRIPE_THIN_EVENTS],
      eventsFrom: ['@self'],
    },
  ];
  const result: WebhookSetupResult = { destinations: [] };
  for (const plan of plans) {
    const found = existing.find(
      (d) =>
        d.name === plan.name && d.event_payload === plan.format && d.webhook_endpoint?.url === url,
    );
    if (found) {
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
      events_from: plan.eventsFrom,
      enabled_events: plan.events,
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
