// ── stripeProvider() ──
// Stripe Connect adapter for @plumbus/payments, on Stripe's newest APIs:
// sellers are Accounts v2 (merchant configuration for direct charges, recipient
// configuration for destination charges and transfers), payment pages are
// Checkout Sessions, the platform's own plans use Billing (prices by lookup key,
// entitlements, meters), account changes arrive as thin v2 events and
// everything else as snapshot events from the platform and sellers' accounts.

import type {
  CheckoutPage,
  DisputeEvidence,
  MerchantComponent,
  PaymentProvider,
  ProviderStateChange,
  StoredProviderEvent,
} from '@plumbus/payments';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import Stripe from 'stripe';
import { findPricesByLookupKey, reconcileCatalog } from './catalog.js';
import {
  cancelCharge,
  captureCharge,
  chargeAccount,
  chargeSavedMethod,
  checkoutExpiry,
  checkoutOptionParams,
  clip,
  createCheckoutCharge,
  createInvoiceCharge,
  customAmountPrice,
  moneyRouting,
  onAccount,
  PRODUCT_NAME_MAX,
} from './charges.js';
import { stripeDefaultResponsibilities, validateStripeConfig } from './config-rules.js';
import {
  diagnoseStripe,
  STRIPE_API_VERSION,
  STRIPE_DESTINATION_NAMES,
  setupStripeDestinations,
} from './diagnose.js';
import { withStripeErrors } from './errors.js';
import { isRelevantStripeEvent, verifyStripeWebhook } from './events.js';
import {
  fromResponsibility,
  mapAccount,
  mapDispute,
  mapPaymentMethod,
  mapPayout,
  mapPayoutSchedule,
  mapRefund,
  mapTransfer,
  type StripeAccountLike,
  type StripeBalanceSettingsLike,
  type StripeDisputeLike,
  type StripePaymentMethodLike,
  type StripePayoutLike,
  type StripeRefundLike,
  type StripeSubscriptionLike,
  type StripeTransferLike,
  mapSubscription,
} from './mapping.js';
import {
  listEntitlementKeys,
  resolveStripeEvent,
  retrieveSubscription,
  SUBSCRIPTION_EXPAND,
} from './resolve.js';
import { keyMode, lazySecret, type SecretSource } from './secrets.js';

export { STRIPE_API_VERSION, STRIPE_DESTINATION_NAMES };

const ACCOUNT_INCLUDE = [
  'configuration.merchant',
  'configuration.recipient',
  'defaults',
  'identity',
  'requirements',
] as const;

export interface StripeProviderOptions {
  /** Secret (`sk_…`) or restricted (`rk_…`) key, or a function returning it. */
  secretKey: SecretSource<string>;
  /** Signing secrets of every event destination (and old ones during a rotation). */
  webhookSecrets: SecretSource<readonly string[]>;
  /** Publishable key for embedded payment pages and Connect embedded components. */
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

function evidenceParams(evidence: DisputeEvidence): Stripe.DisputeUpdateParams.Evidence {
  return {
    ...(evidence.productDescription ? { product_description: evidence.productDescription } : {}),
    ...(evidence.customerName ? { customer_name: evidence.customerName } : {}),
    ...(evidence.customerEmail ? { customer_email_address: evidence.customerEmail } : {}),
    ...(evidence.serviceDate ? { service_date: evidence.serviceDate } : {}),
    // The policy fields take files; the text goes into the disclosures.
    ...(evidence.refundPolicy ? { refund_policy_disclosure: evidence.refundPolicy } : {}),
    ...(evidence.cancellationPolicy
      ? { cancellation_policy_disclosure: evidence.cancellationPolicy }
      : {}),
    ...(evidence.uncategorizedText ? { uncategorized_text: evidence.uncategorizedText } : {}),
  };
}

export function stripeProvider(options: StripeProviderOptions): StripePaymentProvider {
  const secretKey = lazySecret(options.secretKey, 'Stripe secret key');
  const webhookSecrets = lazySecret(options.webhookSecrets, 'Stripe webhook secrets');
  const tolerance = options.webhookToleranceSeconds ?? 300;
  let clientPromise: Promise<Stripe> | undefined;
  // Billing portal configuration per account ('' = the platform), made once when missing.
  const portalConfigurations = new Map<string, Promise<string | null>>();

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

  /** A portal configuration: the account's default, or one made for it the first time. */
  function portalConfiguration(stripe: Stripe, accountId: string | null): Promise<string | null> {
    const key = accountId ?? '';
    let found = portalConfigurations.get(key);
    if (!found) {
      found = (async () => {
        const onIt = onAccount(accountId);
        const [byDefault] = (
          await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 }, onIt)
        ).data;
        if (byDefault) return null;
        const [active] = (
          await stripe.billingPortal.configurations.list({ active: true, limit: 1 }, onIt)
        ).data;
        if (active) return active.id;
        const created = await stripe.billingPortal.configurations.create(
          {
            name: 'Plumbus client portal',
            features: {
              invoice_history: { enabled: true },
              payment_method_update: { enabled: true },
              customer_update: { enabled: true, allowed_updates: ['email', 'address', 'phone'] },
              subscription_cancel: { enabled: true, mode: 'at_period_end' },
            },
          },
          onIt,
        );
        return created.id;
      })().catch((err) => {
        portalConfigurations.delete(key);
        throw err;
      });
      portalConfigurations.set(key, found);
    }
    return found;
  }

  async function lookupPrices(
    stripe: Stripe,
    lookupKeys: string[],
    onIt: Stripe.RequestOptions,
  ): Promise<Map<string, string>> {
    if (lookupKeys.length === 0) return new Map();
    const prices = await findPricesByLookupKey(stripe, lookupKeys, onIt);
    const missing = lookupKeys.filter((key) => !prices.get(key)?.active);
    if (missing.length > 0) {
      throw new PlumbusError(
        ErrorCode.Validation,
        `No active Stripe price has the lookup key ${missing.join(', ')}; run plumbus payments catalog sync`,
        { reason: 'stripe_price_missing', lookupKeys: missing },
      );
    }
    return new Map([...prices].map(([key, price]) => [key, price.id]));
  }

  const provider: StripePaymentProvider = {
    id: 'stripe',
    displayName: 'Stripe',
    publishableKey: options.publishableKey ?? null,
    client,

    defaultResponsibilities: stripeDefaultResponsibilities,
    validateConfig: validateStripeConfig,

    async resolveLivemode() {
      return keyMode(await secretKey()) === 'live';
    },
    isRelevantEvent(event) {
      return isRelevantStripeEvent(event.type);
    },

    // ── Sellers ──

    createMerchantAccount: withStripeErrors(async (input) => {
      const stripe = await client();
      const account = await stripe.v2.core.accounts.create(
        {
          dashboard: input.dashboard,
          ...(input.email ? { contact_email: input.email } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
          identity: { country: input.country.toLowerCase() },
          configuration: {
            ...(input.capabilities.cardPayments
              ? { merchant: { capabilities: { card_payments: { requested: true } } } }
              : {}),
            ...(input.capabilities.transfers
              ? {
                  recipient: {
                    capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
                  },
                }
              : {}),
          },
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
      // Onboard every configuration the account has (merchant, recipient, or both).
      const account = await stripe.v2.core.accounts.retrieve(input.accountId);
      const configurations = (account.applied_configurations ?? []).filter(
        (c): c is 'merchant' | 'recipient' => c === 'merchant' || c === 'recipient',
      );
      const link = await stripe.v2.core.accountLinks.create({
        account: input.accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            configurations: configurations.length > 0 ? configurations : ['merchant'],
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

    // ── Charges ──

    createClient: withStripeErrors(async (input) => {
      const stripe = await client();
      const customer = await stripe.customers.create(
        {
          ...(input.email ? { email: input.email } : {}),
          ...(input.name ? { name: input.name } : {}),
          metadata: input.metadata,
        },
        { ...onAccount(input.sellerAccountId), idempotencyKey: input.idempotencyKey },
      );
      return { clientId: customer.id };
    }),

    createCharge: withStripeErrors(async (input) => createCheckoutCharge(await client(), input)),

    createInvoiceCharge: withStripeErrors(async (input) =>
      createInvoiceCharge(await client(), input),
    ),

    chargeSavedMethod: withStripeErrors(async (input) => chargeSavedMethod(await client(), input)),

    captureCharge: withStripeErrors(async (input) => captureCharge(await client(), input)),

    cancelCharge: withStripeErrors(async (input) => cancelCharge(await client(), input)),

    createRefund: withStripeErrors(async (input) => {
      const stripe = await client();
      const { flow } = input.routing;
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.paymentId,
          ...(input.amount ? { amount: input.amount } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          // Platform charges carry no application fee and no transfer.
          ...(flow !== 'platform' ? { refund_application_fee: input.refundPlatformFee } : {}),
          ...(flow === 'destination' && input.reverseTransfer ? { reverse_transfer: true } : {}),
          metadata: input.metadata,
        },
        {
          ...onAccount(chargeAccount(input.routing)),
          idempotencyKey: input.idempotencyKey,
        },
      );
      return mapRefund(refund as unknown as StripeRefundLike);
    }),

    findRefund: withStripeErrors(async (input) => {
      const stripe = await client();
      const refunds = await stripe.refunds.list(
        { payment_intent: input.paymentId, limit: 100 },
        onAccount(chargeAccount(input.routing)),
      );
      const found = refunds.data.find((r) => r.metadata?.plumbus_refund_id === input.reference);
      return found ? mapRefund(found as unknown as StripeRefundLike) : null;
    }),

    // ── Saved payment methods and the client portal ──

    createSetupSession: withStripeErrors(async (input): Promise<CheckoutPage> => {
      const stripe = await client();
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'setup',
          customer: input.clientId,
          // Cards need no currency on a setup page.
          payment_method_types: ['card'],
          client_reference_id: input.reference,
          metadata: input.metadata,
          setup_intent_data: { metadata: input.metadata },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { ...onAccount(input.sellerAccountId), idempotencyKey: input.idempotencyKey },
      );
      return {
        id: session.id,
        url: session.url,
        clientSecret: null,
        expiresAt: new Date(session.expires_at * 1000),
      };
    }),

    listPaymentMethods: withStripeErrors(async (input) => {
      const stripe = await client();
      const methods = await stripe.customers.listPaymentMethods(
        input.clientId,
        { limit: 100 },
        onAccount(input.sellerAccountId),
      );
      return methods.data.map((m) => mapPaymentMethod(m as unknown as StripePaymentMethodLike));
    }),

    detachPaymentMethod: withStripeErrors(async (input) => {
      const stripe = await client();
      await stripe.paymentMethods.detach(input.methodId, {}, onAccount(input.sellerAccountId));
    }),

    createPortalSession: withStripeErrors(async (input) => {
      const stripe = await client();
      const configuration = await portalConfiguration(stripe, input.sellerAccountId);
      const session = await stripe.billingPortal.sessions.create(
        {
          customer: input.clientId,
          return_url: input.returnUrl,
          ...(configuration ? { configuration } : {}),
        },
        onAccount(input.sellerAccountId),
      );
      return { url: session.url };
    }),

    // ── Subscriptions ──

    createSubscriptionCheckout: withStripeErrors(async (input): Promise<CheckoutPage> => {
      const stripe = await client();
      const onIt = onAccount(chargeAccount(input));
      const prices = await lookupPrices(
        stripe,
        input.items.flatMap((item) => (item.lookupKey ? [item.lookupKey] : [])),
        onIt,
      );
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = input.items.map((item) => {
        const quantity = item.quantity !== undefined ? { quantity: item.quantity } : {};
        if (item.priceId) return { price: item.priceId, ...quantity };
        if (item.lookupKey) return { price: prices.get(item.lookupKey) as string, ...quantity };
        const inline = item.inline;
        if (!inline) {
          throw new PlumbusError(ErrorCode.Validation, 'A subscription item needs a price', {
            reason: 'stripe_subscription_item_price_missing',
          });
        }
        return {
          quantity: item.quantity ?? 1,
          price_data: {
            currency: input.currency,
            unit_amount: inline.unitAmount,
            product_data: { name: clip(inline.name, PRODUCT_NAME_MAX) },
            recurring: { interval: inline.interval, interval_count: inline.intervalCount },
          },
        };
      });
      const seller = input.sellerAccountId;
      const fee =
        input.flow !== 'platform' && input.applicationFeePercent
          ? { application_fee_percent: input.applicationFeePercent }
          : {};
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          ui_mode: input.ui === 'embedded' ? 'embedded_page' : 'hosted_page',
          line_items: lineItems,
          customer: input.clientId,
          client_reference_id: input.reference,
          metadata: input.metadata,
          subscription_data: {
            metadata: input.metadata,
            ...fee,
            ...(input.trialDays && input.trialDays > 0
              ? { trial_period_days: input.trialDays }
              : {}),
            ...(input.flow === 'destination' && seller
              ? {
                  transfer_data: { destination: seller },
                  ...(input.onBehalfOf ? { on_behalf_of: seller } : {}),
                }
              : {}),
          },
          ...(input.ui === 'embedded'
            ? { return_url: input.returnUrl }
            : { success_url: input.successUrl, cancel_url: input.cancelUrl }),
          expires_at: checkoutExpiry(input.expiresAt),
          ...checkoutOptionParams(input.options, 'subscription', true),
        },
        { ...onIt, idempotencyKey: input.idempotencyKey },
      );
      return {
        id: session.id,
        url: session.url,
        clientSecret: session.client_secret,
        expiresAt: new Date(session.expires_at * 1000),
      };
    }),

    retrieveSubscription: withStripeErrors(async (input) =>
      retrieveSubscription(await client(), input.subscriptionId, onAccount(input.sellerAccountId)),
    ),

    updateSubscription: withStripeErrors(async (input) => {
      const stripe = await client();
      const onIt = onAccount(input.sellerAccountId);
      const prices = await lookupPrices(
        stripe,
        (input.items ?? []).flatMap((item) => (item.lookupKey ? [item.lookupKey] : [])),
        onIt,
      );
      const items = input.items?.map((item) => ({
        ...(item.itemId ? { id: item.itemId } : {}),
        ...(item.priceId ? { price: item.priceId } : {}),
        ...(item.lookupKey ? { price: prices.get(item.lookupKey) as string } : {}),
        ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
        ...(item.deleted ? { deleted: true } : {}),
      }));
      const updated = await stripe.subscriptions.update(
        input.subscriptionId,
        {
          ...(items ? { items } : {}),
          ...(input.cancelAtPeriodEnd !== undefined
            ? { cancel_at_period_end: input.cancelAtPeriodEnd }
            : {}),
          proration_behavior: input.prorate ? 'create_prorations' : 'none',
          expand: [...SUBSCRIPTION_EXPAND],
        },
        { ...onIt, idempotencyKey: input.idempotencyKey },
      );
      return mapSubscription(updated as unknown as StripeSubscriptionLike);
    }),

    cancelSubscription: withStripeErrors(async (input) => {
      const stripe = await client();
      const requestOptions = {
        ...onAccount(input.sellerAccountId),
        idempotencyKey: input.idempotencyKey,
      };
      const canceled = input.atPeriodEnd
        ? await stripe.subscriptions.update(
            input.subscriptionId,
            { cancel_at_period_end: true, expand: [...SUBSCRIPTION_EXPAND] },
            requestOptions,
          )
        : await stripe.subscriptions.cancel(
            input.subscriptionId,
            { expand: [...SUBSCRIPTION_EXPAND] },
            requestOptions,
          );
      return mapSubscription(canceled as unknown as StripeSubscriptionLike);
    }),

    // ── Payment links ──

    createPaymentLink: withStripeErrors(async (input) => {
      const stripe = await client();
      const onIt = onAccount(chargeAccount(input));
      const idempotencyKey = `plumbus-link:${input.reference}`;
      const lineItems: Stripe.PaymentLinkCreateParams.LineItem[] = input.customAmount
        ? [
            {
              quantity: 1,
              price: (
                await customAmountPrice(
                  stripe,
                  {
                    currency: input.currency,
                    name: input.items[0]?.name ?? 'Payment',
                    customAmount: input.customAmount,
                  },
                  { ...onIt, idempotencyKey: `${idempotencyKey}:price` },
                )
              ).id,
            },
          ]
        : input.items.map((item) => ({
            quantity: item.quantity,
            price_data: {
              currency: input.currency,
              unit_amount: item.unitAmount,
              product_data: {
                name: clip(item.name, PRODUCT_NAME_MAX),
                ...(item.description ? { description: item.description } : {}),
              },
            },
            ...(item.adjustableQuantity
              ? {
                  adjustable_quantity: {
                    enabled: true,
                    minimum: item.adjustableQuantity.minimum,
                    maximum: item.adjustableQuantity.maximum,
                  },
                }
              : {}),
          }));
      const { transfer_group: transferGroup, ...money } = moneyRouting(
        input,
        input.platformFeeAmount,
      );
      const { options: page } = input;
      const link = await stripe.paymentLinks.create(
        {
          line_items: lineItems,
          metadata: input.metadata,
          payment_intent_data: {
            metadata: input.metadata,
            ...(transferGroup ? { transfer_group: transferGroup } : {}),
            ...(page.statementDescriptorSuffix
              ? { statement_descriptor_suffix: page.statementDescriptorSuffix }
              : {}),
          },
          ...money,
          ...(input.completedUrl
            ? { after_completion: { type: 'redirect', redirect: { url: input.completedUrl } } }
            : {}),
          ...(page.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
          ...(page.automaticTax ? { automatic_tax: { enabled: true } } : {}),
          ...(page.billingAddress ? { billing_address_collection: page.billingAddress } : {}),
          ...(page.phone ? { phone_number_collection: { enabled: true } } : {}),
          ...(page.shippingCountries?.length
            ? {
                shipping_address_collection: {
                  allowed_countries:
                    page.shippingCountries as Stripe.PaymentLinkCreateParams.ShippingAddressCollection.AllowedCountry[],
                },
              }
            : {}),
          ...(page.submitType ? { submit_type: page.submitType } : {}),
        },
        { ...onIt, idempotencyKey },
      );
      return { id: link.id, url: link.url, active: link.active };
    }),

    updatePaymentLink: withStripeErrors(async (input) => {
      const stripe = await client();
      const link = await stripe.paymentLinks.update(
        input.linkId,
        { active: input.active },
        onAccount(input.sellerAccountId),
      );
      return { id: link.id, url: link.url, active: link.active };
    }),

    // ── Transfers ──

    createTransfer: withStripeErrors(async (input) => {
      const stripe = await client();
      // A transfer tied to a payment waits for that payment's funds (source_transaction = its charge).
      let sourceCharge: string | null = null;
      if (input.sourcePaymentId) {
        const intent = await stripe.paymentIntents.retrieve(input.sourcePaymentId);
        sourceCharge =
          typeof intent.latest_charge === 'string'
            ? intent.latest_charge
            : (intent.latest_charge?.id ?? null);
      }
      const transfer = await stripe.transfers.create(
        {
          amount: input.amount,
          currency: input.currency,
          destination: input.destinationAccountId,
          ...(input.transferGroup ? { transfer_group: input.transferGroup } : {}),
          ...(sourceCharge ? { source_transaction: sourceCharge } : {}),
          metadata: {
            ...input.metadata,
            ...(input.sourcePaymentId ? { plumbus_source_payment_id: input.sourcePaymentId } : {}),
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return mapTransfer(transfer as unknown as StripeTransferLike);
    }),

    reverseTransfer: withStripeErrors(async (input) => {
      const stripe = await client();
      await stripe.transfers.createReversal(
        input.transferId,
        {
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return mapTransfer(
        (await stripe.transfers.retrieve(input.transferId)) as unknown as StripeTransferLike,
      );
    }),

    // ── Payouts (Balance Settings manage the schedule of v2 accounts) ──

    retrievePayoutSettings: withStripeErrors(async (input) => {
      const stripe = await client();
      const onIt = onAccount(input.accountId);
      const [settings, balance] = await Promise.all([
        stripe.balanceSettings.retrieve({}, onIt),
        stripe.balance.retrieve({}, onIt),
      ]);
      return {
        schedule: mapPayoutSchedule(settings as unknown as StripeBalanceSettingsLike),
        instantAvailable: (balance.instant_available ?? []).some((entry) => entry.amount > 0),
      };
    }),

    updatePayoutSchedule: withStripeErrors(async (input) => {
      const stripe = await client();
      const onIt = onAccount(input.accountId);
      const { schedule } = input;
      const settings = await stripe.balanceSettings.update(
        {
          payments: {
            payouts: {
              schedule: {
                interval: schedule.interval,
                ...(schedule.interval === 'weekly' && schedule.weeklyAnchor
                  ? { weekly_payout_days: [schedule.weeklyAnchor] }
                  : {}),
                ...(schedule.interval === 'monthly' && schedule.monthlyAnchor
                  ? { monthly_payout_days: [schedule.monthlyAnchor] }
                  : {}),
              },
            },
            ...(schedule.delayDays !== undefined
              ? {
                  settlement_timing: {
                    // '' returns the delay to the shortest the account allows.
                    delay_days_override: schedule.delayDays === 'minimum' ? '' : schedule.delayDays,
                  },
                }
              : {}),
          },
        },
        onIt,
      );
      const balance = await stripe.balance.retrieve({}, onIt);
      return {
        schedule: mapPayoutSchedule(settings as unknown as StripeBalanceSettingsLike),
        instantAvailable: (balance.instant_available ?? []).some((entry) => entry.amount > 0),
      };
    }),

    listPayouts: withStripeErrors(async (input) => {
      const stripe = await client();
      const payouts = await stripe.payouts.list(
        { limit: Math.min(input.limit, 100) },
        onAccount(input.accountId),
      );
      return payouts.data.map((p) => mapPayout(p as unknown as StripePayoutLike));
    }),

    createPayout: withStripeErrors(async (input) => {
      const stripe = await client();
      const payout = await stripe.payouts.create(
        {
          amount: input.amount,
          currency: input.currency,
          method: input.method,
          metadata: input.metadata,
        },
        { ...onAccount(input.accountId), idempotencyKey: input.idempotencyKey },
      );
      return mapPayout(payout as unknown as StripePayoutLike);
    }),

    // ── Disputes ──

    updateDispute: withStripeErrors(async (input) => {
      const stripe = await client();
      const dispute = await stripe.disputes.update(
        input.disputeId,
        { evidence: evidenceParams(input.evidence), submit: input.submit },
        onAccount(input.sellerAccountId),
      );
      return mapDispute(dispute as unknown as StripeDisputeLike);
    }),

    acceptDispute: withStripeErrors(async (input) => {
      const stripe = await client();
      const dispute = await stripe.disputes.close(
        input.disputeId,
        {},
        onAccount(input.sellerAccountId),
      );
      return mapDispute(dispute as unknown as StripeDisputeLike);
    }),

    // ── The platform's own billing ──

    createBillingCustomer: withStripeErrors(async (input) => {
      const stripe = await client();
      const customer = await stripe.customers.create(
        {
          ...(input.email ? { email: input.email } : {}),
          ...(input.name ? { name: input.name } : {}),
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { customerId: customer.id };
    }),

    syncCatalog: withStripeErrors(async (input) => reconcileCatalog(await client(), input, true)),
    checkCatalog: withStripeErrors(async (input) => reconcileCatalog(await client(), input, false)),

    listEntitlements: withStripeErrors(async (input) =>
      listEntitlementKeys(await client(), input.customerId),
    ),

    recordUsage: withStripeErrors(async (input) => {
      const stripe = await client();
      await stripe.billing.meterEvents.create({
        event_name: input.eventName,
        payload: { stripe_customer_id: input.customerId, value: String(input.value) },
        identifier: input.identifier,
        timestamp: Math.floor(input.timestamp.getTime() / 1000),
      });
    }),

    // ── Webhooks ──

    async verifyWebhook({ rawBody, headers }) {
      return verifyStripeWebhook({
        rawBody,
        headers,
        secrets: await webhookSecrets(),
        toleranceSeconds: tolerance,
      });
    },

    resolveEvent: withStripeErrors(
      async (event: StoredProviderEvent): Promise<ProviderStateChange[]> =>
        resolveStripeEvent(await client(), event, async (accountId) => ({
          kind: 'merchant',
          account: await retrieveAccount(accountId),
        })),
    ),

    async diagnose({ webhookUrl, catalog } = {}) {
      return diagnoseStripe({ client, secretKey, webhookSecrets, webhookUrl, catalog });
    },

    setupWebhooks: withStripeErrors(async ({ url }: { url: string }) =>
      setupStripeDestinations(await client(), url),
    ),
  };
  return provider;
}
