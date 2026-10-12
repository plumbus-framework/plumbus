// ── Subscription engine ──
// Subscriptions a seller's client starts (paid to the seller) and the
// platform's own plans (paid to the platform) share one lifecycle: a row saved
// before the provider's checkout page opens, filled in when checkout completes
// (by webhook), then changed, canceled, or resumed through the provider.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@plumbus/core';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import { serializeSubscription } from '../capabilities/schemas.js';
import type {
  ChargeRouting,
  CheckoutOptions,
  CheckoutUi,
  ProviderSubscription,
  SubscriptionItemInput,
  UpdateSubscriptionInput,
} from '../types/provider.js';
import type {
  PaymentClientRow,
  PaymentSubscriptionRow,
  SubscriptionItemView,
} from '../types/records.js';
import { expireSubscriptionCheckout, recordSubscription } from './apply-state.js';
import { findOne, isPendingProviderId, PENDING_PROVIDER_ID, subscriptions } from './repos.js';
import { fillUrl, objectAccount, type PaymentsRuntime, withAppMetadata } from './runtime.js';

export interface SubscriptionParty {
  tenantId: string;
  payee: 'seller' | 'platform';
  merchantAccountId: string | null;
  billingCustomerId: string | null;
  owner: { tenantId: string; ownerType: string; ownerId: string };
  routing: ChargeRouting;
}

export interface SubscriptionSpec {
  /** The subscriber: a seller's client, or the platform's billing customer. */
  client: Pick<PaymentClientRow, 'id' | 'providerClientId'> | null;
  providerCustomerId: string;
  currency: string;
  items: SubscriptionItemInput[];
  /** Item views stored before checkout completes (names, prices). */
  preview: SubscriptionItemView[];
  plan: string | null;
  planPrice: string | null;
  quantity: number;
  trialDays: number | null;
  applicationFeePercent: number | null;
  ui: CheckoutUi;
  urls: { success: string; cancel: string; return: string };
  options: CheckoutOptions;
  requestId: string | null;
  metadata: Record<string, string> | null;
  providerMetadata: Record<string, string>;
  createdBy: string | null;
}

function unsupported(runtime: PaymentsRuntime, feature: string): PlumbusError {
  return new PlumbusError(
    ErrorCode.Validation,
    `${runtime.provider.displayName} does not support ${feature}`,
    { reason: 'payments_provider_feature_unsupported', feature },
  );
}

/** Save a subscription and open its checkout page. */
export async function startSubscription(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  party: SubscriptionParty,
  spec: SubscriptionSpec,
): Promise<PaymentSubscriptionRow> {
  const { provider } = runtime;
  if (!provider.createSubscriptionCheckout) throw unsupported(runtime, 'subscriptions');
  const repo = subscriptions(ctx);
  const id = randomUUID();
  const expiresAt = new Date(
    ctx.time.now().getTime() + runtime.config.checkout.expiresAfterMinutes * 60_000,
  );
  const row = await repo.create({
    id,
    tenantId: party.tenantId,
    payee: party.payee,
    merchantAccountId: party.merchantAccountId,
    clientId: spec.client?.id ?? null,
    billingCustomerId: party.billingCustomerId,
    flow: party.routing.flow,
    provider: provider.id,
    providerSubscriptionId: `${PENDING_PROVIDER_ID}${id}`,
    providerCheckoutId: null,
    requestId: spec.requestId,
    plan: spec.plan,
    planPrice: spec.planPrice,
    status: 'incomplete',
    currency: spec.currency,
    items: spec.preview,
    quantity: spec.quantity,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
    trialEnd: null,
    applicationFeePercent: spec.applicationFeePercent,
    checkoutUrl: null,
    checkoutExpiresAt: expiresAt,
    latestInvoiceId: null,
    createdBy: spec.createdBy,
    metadata: spec.metadata,
    livemode: await provider.resolveLivemode(),
    syncedAt: null,
  });
  const values = { subscriptionId: id, chargeId: id };
  try {
    const page = await provider.createSubscriptionCheckout({
      ...party.routing,
      reference: id,
      clientId: spec.providerCustomerId,
      currency: spec.currency,
      items: spec.items,
      ...(spec.trialDays ? { trialDays: spec.trialDays } : {}),
      ...(spec.applicationFeePercent ? { applicationFeePercent: spec.applicationFeePercent } : {}),
      ui: spec.ui,
      successUrl: fillUrl(spec.urls.success, values),
      cancelUrl: fillUrl(spec.urls.cancel, values),
      returnUrl: fillUrl(spec.urls.return, values),
      expiresAt,
      options: spec.options,
      metadata: withAppMetadata(
        { ...spec.providerMetadata, plumbus_subscription_id: id },
        spec.metadata,
      ),
      idempotencyKey: `plumbus-subscription:${id}`,
    });
    return repo.update(id, {
      providerCheckoutId: page.id,
      checkoutUrl: page.url,
      checkoutExpiresAt: page.expiresAt ?? expiresAt,
    });
  } catch (err) {
    await repo.delete(row.id);
    throw err;
  }
}

/** The subscription a previous call with this requestId started, if any. */
export async function subscriptionForRequest(
  ctx: ExecutionContext,
  party: SubscriptionParty,
  requestId: string,
): Promise<PaymentSubscriptionRow | null> {
  return findOne(subscriptions(ctx), {
    tenantId: party.tenantId,
    payee: party.payee,
    merchantAccountId: party.merchantAccountId,
    billingCustomerId: party.billingCustomerId,
    requestId,
  });
}

/** Write what the provider answered and emit the transition. */
async function record(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  subscription: ProviderSubscription,
  observedAt: Date,
): Promise<PaymentSubscriptionRow> {
  const outcome = await recordSubscription(
    ctx,
    runtime,
    row,
    serializeSubscription(subscription),
    observedAt,
  );
  // A webhook got there first: its row is at least as fresh.
  return outcome.written ? outcome.row : ((await subscriptions(ctx).findById(row.id)) ?? row);
}

function requireStarted(ctx: ExecutionContext, row: PaymentSubscriptionRow): string {
  if (isPendingProviderId(row.providerSubscriptionId)) {
    throw ctx.errors.conflict('The subscription has not started yet (checkout is not complete)', {
      reason: 'payments_subscription_not_started',
    });
  }
  return row.providerSubscriptionId;
}

/** Cancel now, at the end of the period, or — before checkout completes — withdraw it. */
export async function cancelSubscriptionRow(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  routing: ChargeRouting,
  atPeriodEnd: boolean,
): Promise<PaymentSubscriptionRow> {
  const { provider } = runtime;
  if (row.status === 'canceled' || row.status === 'incomplete_expired') return row;
  if (isPendingProviderId(row.providerSubscriptionId)) {
    // Checkout never completed: withdraw its page; the subscription ends unstarted.
    if (row.providerCheckoutId && provider.cancelCharge) {
      await provider.cancelCharge({
        routing,
        collection: 'checkout',
        chargeId: row.providerCheckoutId,
        paymentId: null,
      });
    }
    const outcome = await expireSubscriptionCheckout(ctx, runtime, row, ctx.time.now());
    return outcome.written ? outcome.row : ((await subscriptions(ctx).findById(row.id)) ?? row);
  }
  if (!provider.cancelSubscription) throw unsupported(runtime, 'subscriptions');
  const startedAt = ctx.time.now();
  const result = await provider.cancelSubscription({
    sellerAccountId: objectAccount(routing),
    subscriptionId: requireStarted(ctx, row),
    atPeriodEnd,
    // Each cancel is its own request: a fixed key would replay an older answer after a resume.
    idempotencyKey: `plumbus-subscription-cancel:${row.id}:${randomUUID()}`,
  });
  return record(ctx, runtime, row, result, startedAt);
}

/** Undo a cancellation scheduled for the end of the period. */
export async function resumeSubscriptionRow(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  routing: ChargeRouting,
): Promise<PaymentSubscriptionRow> {
  const { provider } = runtime;
  if (!provider.updateSubscription) throw unsupported(runtime, 'subscriptions');
  if (!row.cancelAtPeriodEnd) return row;
  const startedAt = ctx.time.now();
  const result = await provider.updateSubscription({
    sellerAccountId: objectAccount(routing),
    subscriptionId: requireStarted(ctx, row),
    cancelAtPeriodEnd: false,
    prorate: false,
    idempotencyKey: `plumbus-subscription-resume:${row.id}:${randomUUID()}`,
  });
  return record(ctx, runtime, row, result, startedAt);
}

/** Change a live subscription's items (plan, price, seats). */
export async function changeSubscriptionRow(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  routing: ChargeRouting,
  items: NonNullable<UpdateSubscriptionInput['items']>,
  prorate: boolean,
): Promise<PaymentSubscriptionRow> {
  const { provider } = runtime;
  if (!provider.updateSubscription) throw unsupported(runtime, 'subscriptions');
  const startedAt = ctx.time.now();
  const result = await provider.updateSubscription({
    sellerAccountId: objectAccount(routing),
    subscriptionId: requireStarted(ctx, row),
    items,
    prorate,
    idempotencyKey: `plumbus-subscription-change:${row.id}:${randomUUID()}`,
  });
  return record(ctx, runtime, row, result, startedAt);
}

/** Pull the subscription from the provider now. */
export async function syncSubscriptionRow(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  routing: ChargeRouting,
): Promise<PaymentSubscriptionRow> {
  const { provider } = runtime;
  if (!provider.retrieveSubscription) throw unsupported(runtime, 'subscriptions');
  if (isPendingProviderId(row.providerSubscriptionId)) return row;
  const startedAt = ctx.time.now();
  const result = await provider.retrieveSubscription({
    sellerAccountId: objectAccount(routing),
    subscriptionId: row.providerSubscriptionId,
  });
  return record(ctx, runtime, row, result, startedAt);
}

/** The provider item ids of a subscription, from its latest read. */
export async function providerItems(
  ctx: ExecutionContext,
  runtime: PaymentsRuntime,
  row: PaymentSubscriptionRow,
  routing: ChargeRouting,
): Promise<ProviderSubscription['items']> {
  const { provider } = runtime;
  if (!provider.retrieveSubscription) throw unsupported(runtime, 'subscriptions');
  const current = await provider.retrieveSubscription({
    sellerAccountId: objectAccount(routing),
    subscriptionId: requireStarted(ctx, row),
  });
  return current.items;
}
