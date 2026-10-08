// ── Charges on Stripe ──
// Where money moves (ChargeRouting → Stripe parameters), payment pages
// (Checkout Sessions), invoices, saved payment methods charged off-session,
// holds, and finding the charge a PaymentIntent belongs to.
//
// Flows:
//  • direct       — on the seller's account (Stripe-Account header), with an application fee
//  • destination  — on the platform, `transfer_data.destination` = the seller, with an
//                   application fee; `on_behalf_of` makes the seller the merchant of record
//  • platform     — on the platform, no seller; `transfer_group` ties later transfers

import type {
  ChargeItem,
  ChargeRouting,
  CheckoutOptions,
  CreateChargeInput,
  CreateInvoiceChargeInput,
  ChargeSavedMethodInput,
  CustomAmount,
  ProviderCharge,
} from '@plumbus/payments';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import Stripe from 'stripe';
import {
  idOf,
  mapIntent,
  mapInvoiceCharge,
  mapSession,
  type StripeChargeObjectLike,
  type StripeInvoiceLike,
  type StripePaymentIntentLike,
  type StripeSessionLike,
} from './mapping.js';

// Checkout accepts expires_at 30 minutes to 24 hours after Stripe creates the
// session; keep a minute inside both ends for request time and clock skew.
const CHECKOUT_MIN_SECONDS = 31 * 60;
const CHECKOUT_MAX_SECONDS = 24 * 3600 - 60;
export const PRODUCT_NAME_MAX = 250;

/** Marks PaymentIntents that are charges themselves (a saved method charged off-session). */
export const COLLECTION_METADATA_KEY = 'plumbus_collection';

export const SESSION_EXPAND = [
  'payment_intent.latest_charge',
  'payment_intent.payment_method',
] as const;

/** Cut to `max` UTF-16 units without splitting a surrogate pair (Stripe rejects half emoji). */
export function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function checkoutExpiry(requested: Date): number {
  const now = Math.floor(Date.now() / 1000);
  const wanted = Math.floor(requested.getTime() / 1000);
  return Math.min(Math.max(wanted, now + CHECKOUT_MIN_SECONDS), now + CHECKOUT_MAX_SECONDS);
}

/** Request options for an object on a seller's account, or on the platform (null). */
export function onAccount(accountId: string | null | undefined): Stripe.RequestOptions {
  return accountId ? { stripeAccount: accountId } : {};
}

/** The account a charge's objects live on: the seller's for direct charges, else the platform. */
export function chargeAccount(routing: ChargeRouting): string | null {
  return routing.flow === 'direct' ? routing.sellerAccountId : null;
}

function requireSeller(routing: ChargeRouting): string {
  if (!routing.sellerAccountId) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `A ${routing.flow} charge needs a seller account`,
      {
        reason: 'stripe_seller_account_missing',
      },
    );
  }
  return routing.sellerAccountId;
}

/** Fee and payee fields shared by PaymentIntents, Checkout's payment_intent_data, and invoices. */
export function moneyRouting(
  routing: ChargeRouting,
  platformFeeAmount: number,
): {
  application_fee_amount?: number;
  transfer_data?: { destination: string };
  on_behalf_of?: string;
  transfer_group?: string;
} {
  const fee = platformFeeAmount > 0 ? { application_fee_amount: platformFeeAmount } : {};
  if (routing.flow === 'direct') return fee;
  if (routing.flow === 'destination') {
    const seller = requireSeller(routing);
    return {
      ...fee,
      transfer_data: { destination: seller },
      ...(routing.onBehalfOf ? { on_behalf_of: seller } : {}),
    };
  }
  return routing.transferGroup ? { transfer_group: routing.transferGroup } : {};
}

/** Checkout page options, for payment and subscription pages. */
export function checkoutOptionParams(
  options: CheckoutOptions,
  mode: 'payment' | 'subscription',
  hasCustomer: boolean,
): Partial<Stripe.Checkout.SessionCreateParams> {
  return {
    ...(options.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
    ...(options.automaticTax
      ? {
          automatic_tax: { enabled: true },
          // Tax needs an address; take the one entered on the page for known customers.
          ...(hasCustomer ? { customer_update: { address: 'auto' as const } } : {}),
        }
      : {}),
    ...(options.billingAddress ? { billing_address_collection: options.billingAddress } : {}),
    ...(options.phone ? { phone_number_collection: { enabled: true } } : {}),
    ...(options.shippingCountries?.length
      ? {
          shipping_address_collection: {
            allowed_countries:
              options.shippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
          },
        }
      : {}),
    ...(options.locale
      ? { locale: options.locale as Stripe.Checkout.SessionCreateParams.Locale }
      : {}),
    ...(mode === 'payment' && options.submitType ? { submit_type: options.submitType } : {}),
  };
}

export function lineItemsFor(
  currency: string,
  items: readonly ChargeItem[],
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return items.map((item) => ({
    quantity: item.quantity,
    price_data: {
      currency,
      unit_amount: item.unitAmount,
      product_data: {
        name: clip(item.name, PRODUCT_NAME_MAX),
        ...(item.description ? { description: item.description } : {}),
      },
    },
  }));
}

/** A price whose amount the client chooses (Checkout takes it only as a saved Price). */
export async function customAmountPrice(
  stripe: Stripe,
  input: { currency: string; name: string; customAmount: CustomAmount },
  options: Stripe.RequestOptions,
): Promise<Stripe.Price> {
  const { minimum, maximum, preset } = input.customAmount;
  return stripe.prices.create(
    {
      currency: input.currency,
      custom_unit_amount: {
        enabled: true,
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(preset !== undefined ? { preset } : {}),
      },
      product_data: { name: clip(input.name, PRODUCT_NAME_MAX) },
    },
    options,
  );
}

export async function createCheckoutCharge(
  stripe: Stripe,
  input: CreateChargeInput,
): Promise<ProviderCharge> {
  const account = chargeAccount(input);
  const onIt = onAccount(account);
  const lineItems = input.customAmount
    ? [
        {
          quantity: 1,
          price: (
            await customAmountPrice(
              stripe,
              {
                currency: input.currency,
                name: input.items[0]?.name ?? input.description,
                customAmount: input.customAmount,
              },
              { ...onIt, idempotencyKey: `${input.idempotencyKey}:price` },
            )
          ).id,
        },
      ]
    : lineItemsFor(input.currency, input.items);
  const hasCustomer = Boolean(input.clientId);
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      ui_mode: input.ui === 'embedded' ? 'embedded_page' : 'hosted_page',
      line_items: lineItems,
      ...(input.clientId ? { customer: input.clientId } : {}),
      ...(input.clientEmail && !input.clientId ? { customer_email: input.clientEmail } : {}),
      // A method kept for later needs a customer to belong to.
      ...(input.saveMethod && !input.clientId ? { customer_creation: 'always' as const } : {}),
      client_reference_id: input.reference,
      metadata: input.metadata,
      payment_intent_data: {
        ...moneyRouting(input, input.platformFeeAmount),
        description: input.description,
        metadata: { ...input.metadata, [COLLECTION_METADATA_KEY]: 'checkout' },
        ...(input.capture === 'manual' ? { capture_method: 'manual' as const } : {}),
        ...(input.saveMethod ? { setup_future_usage: 'off_session' as const } : {}),
        ...(input.options.statementDescriptorSuffix
          ? { statement_descriptor_suffix: input.options.statementDescriptorSuffix }
          : {}),
      },
      ...(input.ui === 'embedded'
        ? { return_url: input.returnUrl }
        : { success_url: input.successUrl, cancel_url: input.cancelUrl }),
      expires_at: checkoutExpiry(input.expiresAt),
      ...checkoutOptionParams(input.options, 'payment', hasCustomer),
    },
    { ...onIt, idempotencyKey: input.idempotencyKey },
  );
  return mapSession(session as unknown as StripeSessionLike);
}

async function retrieveInvoice(
  stripe: Stripe,
  invoiceId: string,
  options: Stripe.RequestOptions,
): Promise<StripeInvoiceLike> {
  return (await stripe.invoices.retrieve(
    invoiceId,
    { expand: ['payments'] },
    options,
  )) as unknown as StripeInvoiceLike;
}

/**
 * Email an invoice for a charge. An earlier attempt that crashed part-way may
 * have left the invoice behind (found by the charge id in its metadata); it is
 * finished instead of made twice.
 */
export async function createInvoiceCharge(
  stripe: Stripe,
  input: CreateInvoiceChargeInput,
): Promise<ProviderCharge> {
  const onIt = onAccount(chargeAccount(input));
  const earlier = (
    await stripe.invoices.list({ customer: input.clientId, limit: 20 }, onIt)
  ).data.find(
    (invoice) =>
      invoice.metadata?.plumbus_charge_id === input.reference && invoice.status !== 'void',
  );
  const { transfer_group: _group, ...money } = moneyRouting(input, input.platformFeeAmount);
  let invoice =
    earlier ??
    (await stripe.invoices.create(
      {
        customer: input.clientId,
        currency: input.currency,
        collection_method: 'send_invoice',
        days_until_due: input.dueInDays,
        description: input.description,
        pending_invoice_items_behavior: 'exclude',
        auto_advance: false,
        metadata: input.metadata,
        ...money,
        ...(input.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      },
      { ...onIt, idempotencyKey: `${input.idempotencyKey}:invoice` },
    ));
  if (invoice.status === 'draft') {
    if ((invoice.lines?.data.length ?? 0) === 0) {
      for (const [index, item] of input.items.entries()) {
        await stripe.invoiceItems.create(
          {
            customer: input.clientId,
            invoice: invoice.id,
            currency: input.currency,
            description: item.description ? `${item.name} — ${item.description}` : item.name,
            quantity: item.quantity,
            unit_amount_decimal: Stripe.Decimal.from(item.unitAmount),
            metadata: { plumbus_charge_id: input.reference },
          },
          { ...onIt, idempotencyKey: `${input.idempotencyKey}:item:${index}` },
        );
      }
    }
    invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false }, onIt);
  }
  if (invoice.status === 'open' && !earlier) {
    await stripe.invoices.sendInvoice(
      invoice.id,
      {},
      { ...onIt, idempotencyKey: `${input.idempotencyKey}:send` },
    );
  }
  return mapInvoiceCharge(await retrieveInvoice(stripe, invoice.id, onIt));
}

/** The PaymentIntent a declined off-session payment left behind, from Stripe's error. */
function intentFromError(err: unknown): StripePaymentIntentLike | null {
  if (!(err instanceof Stripe.errors.StripeError)) return null;
  const raw = err.raw as { payment_intent?: StripePaymentIntentLike } | undefined;
  return raw?.payment_intent ?? null;
}

/**
 * Charge a saved method without the client. A decline or a bank that wants the
 * client present is an outcome (failed / requires_action), not an error.
 */
export async function chargeSavedMethod(
  stripe: Stripe,
  input: ChargeSavedMethodInput,
): Promise<ProviderCharge> {
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: input.amount,
        currency: input.currency,
        customer: input.clientId,
        payment_method: input.methodId,
        off_session: true,
        confirm: true,
        description: input.description,
        metadata: { ...input.metadata, [COLLECTION_METADATA_KEY]: 'saved_method' },
        ...(input.capture === 'manual' ? { capture_method: 'manual' as const } : {}),
        ...moneyRouting(input, input.platformFeeAmount),
        ...(input.statementDescriptorSuffix
          ? { statement_descriptor_suffix: input.statementDescriptorSuffix }
          : {}),
        expand: ['latest_charge'],
      },
      { ...onAccount(chargeAccount(input)), idempotencyKey: input.idempotencyKey },
    );
    return mapIntent(intent as unknown as StripePaymentIntentLike);
  } catch (err) {
    const intent = intentFromError(err);
    if (intent) return mapIntent(intent);
    throw err;
  }
}

async function retrieveIntent(
  stripe: Stripe,
  paymentId: string,
  options: Stripe.RequestOptions,
): Promise<StripePaymentIntentLike> {
  return (await stripe.paymentIntents.retrieve(
    paymentId,
    { expand: ['latest_charge', 'payment_method'] },
    options,
  )) as unknown as StripePaymentIntentLike;
}

/**
 * The charge a PaymentIntent belongs to, in the shape its collection reports:
 * the PaymentIntent itself (saved methods), its Checkout Session (payment pages
 * and links), or its invoice (invoices sent as charges). Null = not ours.
 */
export async function chargeForPayment(
  stripe: Stripe,
  paymentId: string,
  accountId: string | null,
): Promise<ProviderCharge | null> {
  const onIt = onAccount(accountId);
  const intent = await retrieveIntent(stripe, paymentId, onIt);
  if (intent.metadata?.[COLLECTION_METADATA_KEY] === 'saved_method') return mapIntent(intent);

  const [session] = (
    await stripe.checkout.sessions.list(
      {
        payment_intent: paymentId,
        limit: 1,
        expand: SESSION_EXPAND.map((path) => `data.${path}`),
      },
      onIt,
    )
  ).data;
  if (session) return mapSession(session as unknown as StripeSessionLike);

  const [invoicePayment] = (
    await stripe.invoicePayments.list(
      { payment: { type: 'payment_intent', payment_intent: paymentId }, limit: 1 },
      onIt,
    )
  ).data;
  const invoiceId = idOf(invoicePayment?.invoice as string | { id: string } | null | undefined);
  if (!invoiceId) return null;
  const invoice = await retrieveInvoice(stripe, invoiceId, onIt);
  if (!invoice.metadata?.plumbus_charge_id) return null;
  const latest = intent.latest_charge;
  return {
    ...mapInvoiceCharge(invoice),
    paymentId,
    amountRefunded:
      latest && typeof latest === 'object'
        ? ((latest as StripeChargeObjectLike).amount_refunded ?? 0)
        : null,
  };
}

export async function captureCharge(
  stripe: Stripe,
  input: {
    routing: ChargeRouting;
    paymentId: string;
    amount?: number;
    platformFeeAmount?: number;
    idempotencyKey: string;
  },
): Promise<ProviderCharge> {
  const intent = await stripe.paymentIntents.capture(
    input.paymentId,
    {
      ...(input.amount !== undefined ? { amount_to_capture: input.amount } : {}),
      ...(input.platformFeeAmount !== undefined && input.routing.flow !== 'platform'
        ? { application_fee_amount: input.platformFeeAmount }
        : {}),
      expand: ['latest_charge'],
    },
    { ...onAccount(chargeAccount(input.routing)), idempotencyKey: input.idempotencyKey },
  );
  return mapIntent(intent as unknown as StripePaymentIntentLike);
}

const CANCELABLE_INTENT: ReadonlySet<string | undefined> = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
  'processing',
]);

async function releaseIntent(
  stripe: Stripe,
  paymentId: string,
  options: Stripe.RequestOptions,
): Promise<StripePaymentIntentLike> {
  const intent = await retrieveIntent(stripe, paymentId, options);
  if (!CANCELABLE_INTENT.has(intent.status)) return intent;
  return (await stripe.paymentIntents.cancel(
    paymentId,
    { expand: ['latest_charge'] },
    options,
  )) as unknown as StripePaymentIntentLike;
}

/** Stop a charge: expire its payment page, void its invoice, or release its hold. */
export async function cancelCharge(
  stripe: Stripe,
  input: {
    routing: ChargeRouting;
    collection: string;
    chargeId: string;
    paymentId: string | null;
  },
): Promise<ProviderCharge> {
  const onIt = onAccount(chargeAccount(input.routing));

  if (input.collection === 'invoice') {
    const invoice = await retrieveInvoice(stripe, input.chargeId, onIt);
    if (invoice.status === 'draft') {
      await stripe.invoices.del(input.chargeId, onIt);
      return { ...mapInvoiceCharge(invoice), status: 'canceled', url: null };
    }
    if (invoice.status === 'open') {
      await stripe.invoices.voidInvoice(input.chargeId, {}, onIt);
      return mapInvoiceCharge(await retrieveInvoice(stripe, input.chargeId, onIt));
    }
    return mapInvoiceCharge(invoice);
  }

  // A payment page: the charge's own, or one opened for a saved method that needed the client.
  if (input.chargeId.startsWith('cs_')) {
    let session = (await stripe.checkout.sessions.retrieve(
      input.chargeId,
      { expand: [...SESSION_EXPAND] },
      onIt,
    )) as unknown as StripeSessionLike;
    if (session.status === 'open') {
      session = (await stripe.checkout.sessions.expire(
        input.chargeId,
        { expand: [...SESSION_EXPAND] },
        onIt,
      )) as unknown as StripeSessionLike;
    } else if (idOf(session.payment_intent) && input.collection !== 'saved_method') {
      // A completed page with a hold: release it.
      await releaseIntent(stripe, idOf(session.payment_intent) as string, onIt);
      session = (await stripe.checkout.sessions.retrieve(
        input.chargeId,
        { expand: [...SESSION_EXPAND] },
        onIt,
      )) as unknown as StripeSessionLike;
    }
    if (input.collection !== 'saved_method' || !input.paymentId) return mapSession(session);
  }

  // A saved method charged off-session: the PaymentIntent is the charge.
  const paymentId = input.paymentId ?? input.chargeId;
  return mapIntent(await releaseIntent(stripe, paymentId, onIt));
}
