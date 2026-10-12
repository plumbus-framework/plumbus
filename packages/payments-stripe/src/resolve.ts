// ── Stripe events → state changes ──
// Events are hints: every change is read fresh from Stripe, on the account the
// event came from (a seller's, or the platform's when `accountId` is null).
// A charge is listed before its refunds and disputes, and a subscription before
// its invoices, because the worker matches them through the rows those create.

import type { ProviderStateChange, StoredProviderEvent } from '@plumbus/payments';
import type Stripe from 'stripe';
import { featureKeysOf } from './catalog.js';
import { chargeForPayment, onAccount, SESSION_EXPAND } from './charges.js';
import {
  idOf,
  mapDispute,
  mapInvoice,
  mapInvoiceCharge,
  mapPaymentMethod,
  mapPayout,
  mapRefund,
  mapSession,
  mapSubscription,
  mapTransfer,
  type StripeDisputeLike,
  type StripeInvoiceLike,
  type StripePaymentMethodLike,
  type StripePayoutLike,
  type StripeRefundLike,
  type StripeSessionLike,
  type StripeSubscriptionLike,
  type StripeTransferLike,
} from './mapping.js';

export const SUBSCRIPTION_EXPAND = ['items.data.price.product'] as const;

export async function retrieveSubscription(
  stripe: Stripe,
  subscriptionId: string,
  options: Stripe.RequestOptions,
) {
  return mapSubscription(
    (await stripe.subscriptions.retrieve(
      subscriptionId,
      { expand: [...SUBSCRIPTION_EXPAND] },
      options,
    )) as unknown as StripeSubscriptionLike,
  );
}

/** Active entitlement feature keys of a customer. */
export async function listEntitlementKeys(stripe: Stripe, customerId: string): Promise<string[]> {
  const lookupKeys: string[] = [];
  for await (const entitlement of stripe.entitlements.activeEntitlements.list({
    customer: customerId,
    limit: 100,
  })) {
    lookupKeys.push(entitlement.lookup_key);
  }
  return featureKeysOf(lookupKeys);
}

async function paymentAndThen(
  stripe: Stripe,
  accountId: string | null,
  paymentId: string | null,
): Promise<{ changes: ProviderStateChange[]; reference: string | null }> {
  if (!paymentId) return { changes: [], reference: null };
  const charge = await chargeForPayment(stripe, paymentId, accountId);
  if (!charge) return { changes: [], reference: null };
  return { changes: [{ kind: 'charge', accountId, charge }], reference: charge.reference };
}

export async function resolveStripeEvent(
  stripe: Stripe,
  event: StoredProviderEvent,
  retrieveAccount: (accountId: string) => Promise<ProviderStateChange & { kind: 'merchant' }>,
): Promise<ProviderStateChange[]> {
  const accountId = event.accountId;
  const objectId = event.objectId;
  if (!objectId) return [];

  if (event.format === 'thin') {
    return event.objectType === 'v2.core.account' ? [await retrieveAccount(objectId)] : [];
  }

  const onIt = onAccount(accountId);
  const type = event.type;

  if (type.startsWith('checkout.session.')) {
    const session = (await stripe.checkout.sessions.retrieve(
      objectId,
      { expand: [...SESSION_EXPAND, 'setup_intent.payment_method'] },
      onIt,
    )) as unknown as StripeSessionLike;
    if (session.mode === 'subscription') {
      if (session.status === 'expired') {
        return [
          {
            kind: 'subscription_checkout_expired',
            accountId,
            checkoutId: session.id,
            reference: session.client_reference_id ?? null,
          },
        ];
      }
      const subscriptionId = idOf(session.subscription);
      if (!subscriptionId) return [];
      return [
        {
          kind: 'subscription',
          accountId,
          subscription: await retrieveSubscription(stripe, subscriptionId, onIt),
        },
      ];
    }
    if (session.mode === 'setup') {
      const setup = session.setup_intent;
      const method = setup && typeof setup === 'object' ? setup.payment_method : null;
      if (session.status !== 'complete' || !method || typeof method !== 'object') return [];
      return [
        {
          kind: 'payment_method',
          accountId,
          method: mapPaymentMethod(method as StripePaymentMethodLike),
          detached: false,
        },
      ];
    }
    return [{ kind: 'charge', accountId, charge: mapSession(session) }];
  }

  if (type.startsWith('payment_intent.')) {
    return (await paymentAndThen(stripe, accountId, objectId)).changes;
  }

  if (
    type === 'charge.refunded' ||
    type === 'charge.refund.updated' ||
    type.startsWith('refund.')
  ) {
    const refunds =
      event.objectType === 'refund'
        ? [(await stripe.refunds.retrieve(objectId, {}, onIt)) as unknown as StripeRefundLike]
        : ((await stripe.refunds.list({ charge: objectId, limit: 100 }, onIt))
            .data as unknown as StripeRefundLike[]);
    const paymentId = refunds[0] ? mapRefund(refunds[0]).paymentId || null : null;
    const { changes, reference } = await paymentAndThen(stripe, accountId, paymentId);
    for (const refund of refunds) {
      changes.push({
        kind: 'refund',
        accountId,
        chargeReference: reference,
        refund: mapRefund(refund),
      });
    }
    return changes;
  }

  if (type.startsWith('charge.dispute.')) {
    const dispute = mapDispute(
      (await stripe.disputes.retrieve(objectId, {}, onIt)) as unknown as StripeDisputeLike,
    );
    const { changes, reference } = await paymentAndThen(
      stripe,
      accountId,
      dispute.paymentId || null,
    );
    return [...changes, { kind: 'dispute', accountId, chargeReference: reference, dispute }];
  }

  if (type.startsWith('payment_method.')) {
    const method = (await stripe.paymentMethods.retrieve(
      objectId,
      {},
      onIt,
    )) as unknown as StripePaymentMethodLike;
    return [
      {
        kind: 'payment_method',
        accountId,
        method: mapPaymentMethod(method),
        // Detaching clears the customer.
        detached: idOf(method.customer) === null,
      },
    ];
  }

  if (type.startsWith('customer.subscription.')) {
    return [
      {
        kind: 'subscription',
        accountId,
        subscription: await retrieveSubscription(stripe, objectId, onIt),
      },
    ];
  }

  if (type.startsWith('invoice.')) {
    const invoice = (await stripe.invoices.retrieve(
      objectId,
      { expand: ['payments'] },
      onIt,
    )) as unknown as StripeInvoiceLike;
    const mapped = mapInvoice(invoice);
    if (mapped.subscriptionId) {
      return [
        {
          kind: 'subscription',
          accountId,
          subscription: await retrieveSubscription(stripe, mapped.subscriptionId, onIt),
        },
        { kind: 'invoice', accountId, invoice: mapped },
      ];
    }
    // A one-off invoice sent as a charge.
    if (invoice.metadata?.plumbus_charge_id) {
      return [{ kind: 'charge', accountId, charge: mapInvoiceCharge(invoice) }];
    }
    return [];
  }

  if (type.startsWith('transfer.')) {
    const transfer = (await stripe.transfers.retrieve(objectId)) as unknown as StripeTransferLike;
    return [{ kind: 'transfer', transfer: mapTransfer(transfer) }];
  }

  if (type.startsWith('payout.')) {
    // The platform's own payouts are not a seller's.
    if (!accountId) return [];
    const payout = (await stripe.payouts.retrieve(
      objectId,
      {},
      onIt,
    )) as unknown as StripePayoutLike;
    return [{ kind: 'payout', accountId, payout: mapPayout(payout) }];
  }

  if (type === 'entitlements.active_entitlement_summary.updated') {
    return [
      {
        kind: 'entitlements',
        customerId: objectId,
        features: await listEntitlementKeys(stripe, objectId),
      },
    ];
  }

  return [];
}
