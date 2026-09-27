// ── Stripe objects → neutral payments shapes ──
// Structural "…Like" types name only the fields this adapter reads, so the
// mapping is easy to test with plain fixtures and robust to SDK type churn.

import type {
  BillingInterval,
  ChargeStatus,
  DisputeStatus,
  InvoiceStatus,
  MerchantDashboard,
  PayoutSchedule,
  PayoutStatus,
  ProviderCharge,
  ProviderDispute,
  ProviderInvoice,
  ProviderMerchantAccount,
  ProviderPaymentMethod,
  ProviderPayout,
  ProviderRefund,
  ProviderSubscription,
  ProviderSubscriptionItem,
  ProviderTransfer,
  RefundStatus,
  Responsibility,
  SubscriptionStatus,
} from '@plumbus/payments';

type Ref<T> = string | T | null | undefined;

interface CapabilityStatusLike {
  status?: string;
  status_details?: Array<{ code?: string }>;
}

export interface StripeAccountLike {
  id: string;
  closed?: boolean;
  dashboard?: string | null;
  livemode: boolean;
  applied_configurations?: string[] | null;
  identity?: { country?: string | null } | null;
  defaults?: {
    currency?: string | null;
    responsibilities?: { fees_collector?: string | null; losses_collector?: string | null } | null;
  } | null;
  configuration?: {
    merchant?: {
      capabilities?: {
        card_payments?: CapabilityStatusLike | null;
        stripe_balance?: { payouts?: CapabilityStatusLike | null } | null;
      } | null;
    } | null;
    recipient?: {
      capabilities?: {
        stripe_balance?: {
          payouts?: CapabilityStatusLike | null;
          stripe_transfers?: CapabilityStatusLike | null;
        } | null;
      } | null;
    } | null;
  } | null;
  requirements?: {
    entries?: Array<{
      description?: string;
      awaiting_action_from?: string;
      minimum_deadline?: { status?: string } | null;
    }> | null;
  } | null;
}

export interface StripePaymentMethodLike {
  id: string;
  type: string;
  customer?: Ref<{ id: string }>;
  card?: { brand?: string | null; last4?: string | null; exp_month?: number; exp_year?: number };
  sepa_debit?: { last4?: string | null } | null;
  us_bank_account?: { last4?: string | null; bank_name?: string | null } | null;
}

export interface StripeChargeObjectLike {
  id: string;
  amount_refunded?: number;
  created?: number;
  payment_method_details?: { card?: { capture_before?: number | null } | null } | null;
}

export interface StripePaymentIntentLike {
  id: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  amount_capturable?: number;
  currency?: string;
  livemode?: boolean;
  application_fee_amount?: number | null;
  setup_future_usage?: string | null;
  receipt_email?: string | null;
  customer?: Ref<{ id: string }>;
  metadata?: Record<string, string> | null;
  latest_charge?: Ref<StripeChargeObjectLike>;
  payment_method?: Ref<StripePaymentMethodLike>;
  last_payment_error?: { code?: string | null; decline_code?: string | null } | null;
}

export interface StripeSessionLike {
  id: string;
  mode?: string | null;
  status?: string | null;
  payment_status?: string | null;
  url?: string | null;
  client_secret?: string | null;
  expires_at?: number | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  total_details?: { amount_discount?: number; amount_tax?: number } | null;
  currency?: string | null;
  livemode: boolean;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  customer?: Ref<{ id: string }>;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  payment_intent?: Ref<StripePaymentIntentLike>;
  payment_link?: Ref<{ id: string }>;
  subscription?: Ref<{ id: string }>;
  setup_intent?: Ref<{ id: string; payment_method?: Ref<StripePaymentMethodLike> }>;
}

export interface StripeRefundLike {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  reason?: string | null;
  failure_reason?: string | null;
  metadata?: Record<string, string> | null;
  payment_intent?: Ref<{ id: string }>;
  charge?: Ref<{ id: string }>;
}

export interface StripeDisputeLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason?: string | null;
  payment_intent?: Ref<{ id: string }>;
  evidence_details?: { due_by?: number | null; submission_count?: number | null } | null;
}

export interface StripePriceLike {
  id: string;
  active?: boolean;
  currency: string;
  lookup_key?: string | null;
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  product?: Ref<{ id: string; name?: string; deleted?: boolean }>;
  recurring?: {
    interval: string;
    interval_count?: number;
    usage_type?: string;
    meter?: string | null;
  } | null;
}

export interface StripeSubscriptionLike {
  id: string;
  status: string;
  currency: string;
  livemode: boolean;
  customer: Ref<{ id: string }>;
  metadata?: Record<string, string> | null;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  ended_at?: number | null;
  trial_end?: number | null;
  latest_invoice?: Ref<{ id: string }>;
  application_fee_percent?: number | null;
  items: {
    data: Array<{
      id: string;
      quantity?: number | null;
      current_period_end?: number | null;
      price: StripePriceLike;
    }>;
  };
}

export interface StripeInvoiceLike {
  id: string;
  status?: string | null;
  currency: string;
  livemode: boolean;
  metadata?: Record<string, string> | null;
  customer?: Ref<{ id: string }>;
  customer_email?: string | null;
  subtotal?: number;
  total?: number;
  amount_due?: number;
  amount_paid?: number;
  amount_remaining?: number;
  application_fee_amount?: number | null;
  total_discount_amounts?: Array<{ amount: number }> | null;
  total_taxes?: Array<{ amount: number }> | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  number?: string | null;
  due_date?: number | null;
  period_start?: number | null;
  period_end?: number | null;
  billing_reason?: string | null;
  attempt_count?: number;
  status_transitions?: { paid_at?: number | null } | null;
  parent?: {
    subscription_details?: { subscription?: Ref<{ id: string }> } | null;
  } | null;
  payments?: {
    data?: Array<{
      status?: string | null;
      payment?: { payment_intent?: Ref<{ id: string }> } | null;
    }>;
  } | null;
}

export interface StripeTransferLike {
  id: string;
  amount: number;
  amount_reversed?: number;
  currency: string;
  livemode: boolean;
  destination?: Ref<{ id: string }>;
  transfer_group?: string | null;
  metadata?: Record<string, string> | null;
}

export interface StripePayoutLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  arrival_date?: number | null;
  failure_code?: string | null;
  livemode: boolean;
}

export const idOf = (value: Ref<{ id: string }>): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

/** The expanded object, or null when the field holds only an id. */
const expanded = <T extends object>(value: Ref<T>): T | null =>
  value && typeof value === 'object' ? value : null;

const fromUnix = (seconds: number | null | undefined): Date | null =>
  seconds ? new Date(seconds * 1000) : null;

const sum = (entries: Array<{ amount: number }> | null | undefined): number | null =>
  entries ? entries.reduce((total, entry) => total + entry.amount, 0) : null;

export function toResponsibility(value: string | null | undefined): Responsibility {
  return value === 'stripe' ? 'provider' : 'platform';
}

export function fromResponsibility(value: Responsibility): 'stripe' | 'application' {
  return value === 'provider' ? 'stripe' : 'application';
}

function toDashboard(value: string | null | undefined): MerchantDashboard {
  return value === 'express' || value === 'none' ? value : 'full';
}

export function mapAccount(account: StripeAccountLike): ProviderMerchantAccount {
  const merchant = account.configuration?.merchant?.capabilities;
  const recipient = account.configuration?.recipient?.capabilities?.stripe_balance;
  const cards = merchant?.card_payments;
  const transfers = recipient?.stripe_transfers;
  const payouts = merchant?.stripe_balance?.payouts ?? recipient?.payouts;
  const due: string[] = [];
  const pastDue: string[] = [];
  for (const entry of account.requirements?.entries ?? []) {
    const status = entry.minimum_deadline?.status;
    const label = entry.description ?? 'Additional information';
    if (entry.awaiting_action_from === 'stripe') continue;
    if (status === 'currently_due' || status === 'past_due') due.push(label);
    if (status === 'past_due') pastDue.push(label);
  }
  // The capability the seller is paid through: card payments, or transfers when that is all they have.
  const main = cards ?? transfers;
  const restricted = main?.status === 'restricted' || main?.status === 'unsupported';
  return {
    id: account.id,
    dashboard: toDashboard(account.dashboard),
    feesCollector: toResponsibility(account.defaults?.responsibilities?.fees_collector ?? 'stripe'),
    lossesCollector: toResponsibility(
      account.defaults?.responsibilities?.losses_collector ?? 'stripe',
    ),
    country: account.identity?.country ? account.identity.country.toUpperCase() : null,
    defaultCurrency: account.defaults?.currency ?? null,
    chargesEnabled: cards?.status === 'active',
    transfersEnabled: transfers?.status === 'active',
    payoutsEnabled: payouts?.status === 'active',
    requirementsDue: due,
    requirementsPastDue: pastDue,
    disabledReason: restricted ? (main?.status_details?.[0]?.code ?? main?.status ?? null) : null,
    closed: account.closed === true,
    livemode: account.livemode,
  };
}

export function mapPaymentMethod(method: StripePaymentMethodLike): ProviderPaymentMethod {
  return {
    id: method.id,
    customerId: idOf(method.customer),
    type: method.type,
    brand: method.card?.brand ?? method.us_bank_account?.bank_name ?? null,
    last4: method.card?.last4 ?? method.sepa_debit?.last4 ?? method.us_bank_account?.last4 ?? null,
    expMonth: method.card?.exp_month ?? null,
    expYear: method.card?.exp_year ?? null,
  };
}

function failureCodeOf(intent: StripePaymentIntentLike | null): string | null {
  const error = intent?.last_payment_error;
  return error ? (error.decline_code ?? error.code ?? null) : null;
}

/** Refunded so far: null when the read did not include the charge (the stored value is kept). */
function refundedOf(intent: StripePaymentIntentLike | null, hasPayment: boolean): number | null {
  if (!hasPayment) return 0;
  const latest = expanded(intent?.latest_charge);
  if (latest) return latest.amount_refunded ?? 0;
  return intent && intent.latest_charge == null ? 0 : null;
}

function captureBeforeOf(intent: StripePaymentIntentLike | null): Date | null {
  return fromUnix(expanded(intent?.latest_charge)?.payment_method_details?.card?.capture_before);
}

function paidAtOf(intent: StripePaymentIntentLike | null): Date | null {
  return fromUnix(expanded(intent?.latest_charge)?.created);
}

/** The method a payment saved for later use, when it was saved on a customer. */
function savedMethodOf(intent: StripePaymentIntentLike | null): ProviderPaymentMethod | null {
  const method = expanded(intent?.payment_method);
  if (!intent?.setup_future_usage || !method || !idOf(method.customer)) return null;
  return mapPaymentMethod(method);
}

function sessionStatus(
  session: StripeSessionLike,
  intent: StripePaymentIntentLike | null,
): ChargeStatus {
  if (session.status === 'expired') return 'expired';
  if (session.status !== 'complete') return 'open';
  if (intent?.status === 'requires_capture') return 'authorized';
  if (intent?.status === 'canceled') return 'canceled';
  if (intent?.status === 'succeeded') return 'paid';
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    return 'paid';
  }
  if (intent?.status === 'requires_payment_method') return 'failed';
  return 'processing';
}

/** A payment-mode Checkout Session (a charge's page, or one payment through a link). */
export function mapSession(session: StripeSessionLike): ProviderCharge {
  const intent = expanded(session.payment_intent);
  const status = sessionStatus(session, intent);
  // A partial capture takes less than the page asked for.
  const captured =
    intent?.status === 'succeeded' && intent.amount_received !== undefined
      ? intent.amount_received
      : null;
  const open = status === 'open';
  return {
    id: session.id,
    reference: session.client_reference_id ?? session.metadata?.plumbus_charge_id ?? null,
    paymentId: idOf(session.payment_intent),
    linkId: idOf(session.payment_link),
    status,
    currency: session.currency ?? '',
    amountSubtotal: session.amount_subtotal ?? null,
    amountTotal:
      captured !== null && session.amount_total != null
        ? Math.min(captured, session.amount_total)
        : (session.amount_total ?? null),
    amountDiscount: session.total_details?.amount_discount ?? null,
    amountTax: session.total_details?.amount_tax ?? null,
    // Null = not in this read (no payment yet, or ids that were not expanded).
    platformFeeAmount: intent ? (intent.application_fee_amount ?? 0) : null,
    amountRefunded: refundedOf(intent, session.payment_intent != null),
    amountCapturable: intent ? (intent.amount_capturable ?? 0) : null,
    captureBefore: captureBeforeOf(intent),
    url: open ? (session.url ?? null) : null,
    clientSecret: open ? (session.client_secret ?? null) : null,
    expiresAt: fromUnix(session.expires_at),
    paidAt: status === 'paid' ? paidAtOf(intent) : null,
    clientEmail: session.customer_details?.email ?? session.customer_email ?? null,
    customerId: idOf(session.customer),
    savedMethod: savedMethodOf(intent),
    failureCode: failureCodeOf(intent),
    livemode: session.livemode,
  };
}

function intentStatus(intent: StripePaymentIntentLike): ChargeStatus {
  switch (intent.status) {
    case 'succeeded':
      return 'paid';
    case 'requires_capture':
      return 'authorized';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_action':
    case 'requires_confirmation':
      return 'requires_action';
    default:
      // requires_payment_method: declined (failed), or the bank wants the client present.
      if (!intent.last_payment_error) return 'open';
      return intent.last_payment_error.code === 'authentication_required'
        ? 'requires_action'
        : 'failed';
  }
}

/** A PaymentIntent that is the charge itself (a saved method charged without the client). */
export function mapIntent(intent: StripePaymentIntentLike): ProviderCharge {
  const status = intentStatus(intent);
  const amount = intent.amount ?? 0;
  return {
    id: intent.id,
    reference: intent.metadata?.plumbus_charge_id ?? null,
    paymentId: intent.id,
    linkId: null,
    status,
    currency: intent.currency ?? '',
    amountSubtotal: amount,
    amountTotal: status === 'paid' ? (intent.amount_received ?? amount) : amount,
    amountDiscount: null,
    amountTax: null,
    platformFeeAmount: intent.application_fee_amount ?? 0,
    amountRefunded: refundedOf(intent, true),
    amountCapturable: intent.amount_capturable ?? 0,
    captureBefore: captureBeforeOf(intent),
    url: null,
    clientSecret: null,
    expiresAt: null,
    paidAt: status === 'paid' ? paidAtOf(intent) : null,
    clientEmail: intent.receipt_email ?? null,
    customerId: idOf(intent.customer),
    savedMethod: null,
    failureCode: failureCodeOf(intent),
    livemode: intent.livemode ?? false,
  };
}

/** The payment that settled (or is settling) an invoice. */
export function invoicePaymentId(invoice: StripeInvoiceLike): string | null {
  const payments = invoice.payments?.data ?? [];
  const chosen = payments.find((p) => p.status === 'paid') ?? payments[0];
  return idOf(chosen?.payment?.payment_intent);
}

function invoiceChargeStatus(status: string | null | undefined): ChargeStatus {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'void':
      return 'canceled';
    case 'uncollectible':
      return 'failed';
    default:
      return 'open';
  }
}

/** A one-off invoice sent as a charge. */
export function mapInvoiceCharge(invoice: StripeInvoiceLike): ProviderCharge {
  const status = invoiceChargeStatus(invoice.status);
  return {
    id: invoice.id,
    reference: invoice.metadata?.plumbus_charge_id ?? null,
    paymentId: invoicePaymentId(invoice),
    linkId: null,
    status,
    currency: invoice.currency,
    amountSubtotal: invoice.subtotal ?? null,
    amountTotal: invoice.total ?? null,
    amountDiscount: sum(invoice.total_discount_amounts),
    amountTax: sum(invoice.total_taxes),
    platformFeeAmount: invoice.application_fee_amount ?? 0,
    amountRefunded: null,
    amountCapturable: 0,
    captureBefore: null,
    url: status === 'open' ? (invoice.hosted_invoice_url ?? null) : null,
    clientSecret: null,
    expiresAt: null,
    paidAt: status === 'paid' ? fromUnix(invoice.status_transitions?.paid_at) : null,
    clientEmail: invoice.customer_email ?? null,
    customerId: idOf(invoice.customer),
    savedMethod: null,
    failureCode: null,
    livemode: invoice.livemode,
  };
}

const INVOICE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'open',
  'paid',
  'void',
  'uncollectible',
]);

export function mapInvoice(invoice: StripeInvoiceLike): ProviderInvoice {
  const status = (
    invoice.status && INVOICE_STATUSES.has(invoice.status) ? invoice.status : 'draft'
  ) as InvoiceStatus;
  return {
    id: invoice.id,
    reference: invoice.metadata?.plumbus_charge_id ?? null,
    subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
    customerId: idOf(invoice.customer),
    status,
    currency: invoice.currency,
    amountDue: invoice.amount_due ?? 0,
    amountPaid: invoice.amount_paid ?? 0,
    amountRemaining: invoice.amount_remaining ?? 0,
    hostedUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
    number: invoice.number ?? null,
    dueDate: fromUnix(invoice.due_date),
    paymentId: invoicePaymentId(invoice),
    periodStart: fromUnix(invoice.period_start),
    periodEnd: fromUnix(invoice.period_end),
    billingReason: invoice.billing_reason ?? null,
    attemptCount: invoice.attempt_count ?? 0,
    livemode: invoice.livemode,
  };
}

const INTERVALS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'year']);

function mapSubscriptionItem(
  item: StripeSubscriptionLike['items']['data'][number],
): ProviderSubscriptionItem {
  const price = item.price;
  const product = expanded(price.product);
  const interval = price.recurring?.interval ?? 'month';
  const metered = price.recurring?.usage_type === 'metered';
  return {
    id: item.id,
    priceId: price.id,
    lookupKey: price.lookup_key ?? null,
    name: product?.name ?? price.lookup_key ?? price.id,
    unitAmount: price.unit_amount ?? null,
    currency: price.currency,
    interval: (INTERVALS.has(interval) ? interval : 'month') as BillingInterval,
    intervalCount: price.recurring?.interval_count ?? 1,
    quantity: metered ? 0 : (item.quantity ?? 1),
    metered,
  };
}

const SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
]);

export function mapSubscription(subscription: StripeSubscriptionLike): ProviderSubscription {
  const items = subscription.items.data;
  const periodEnds = items
    .map((item) => item.current_period_end)
    .filter((end): end is number => typeof end === 'number');
  return {
    id: subscription.id,
    reference: subscription.metadata?.plumbus_subscription_id ?? null,
    customerId: idOf(subscription.customer) ?? '',
    status: (SUBSCRIPTION_STATUSES.has(subscription.status)
      ? subscription.status
      : 'incomplete') as SubscriptionStatus,
    currency: subscription.currency,
    items: items.map(mapSubscriptionItem),
    currentPeriodEnd: periodEnds.length > 0 ? fromUnix(Math.max(...periodEnds)) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    canceledAt: fromUnix(subscription.canceled_at),
    endedAt: fromUnix(subscription.ended_at),
    trialEnd: fromUnix(subscription.trial_end),
    latestInvoiceId: idOf(subscription.latest_invoice),
    applicationFeePercent: subscription.application_fee_percent ?? null,
    livemode: subscription.livemode,
  };
}

const REFUND_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'canceled',
]);

export function mapRefund(refund: StripeRefundLike): ProviderRefund {
  const status = (
    refund.status && REFUND_STATUSES.has(refund.status) ? refund.status : 'pending'
  ) as RefundStatus;
  return {
    id: refund.id,
    reference: refund.metadata?.plumbus_refund_id ?? null,
    paymentId: idOf(refund.payment_intent) ?? '',
    amount: refund.amount,
    currency: refund.currency,
    status,
    reason: refund.reason ?? null,
    failureReason: refund.failure_reason ?? null,
  };
}

export function toDisputeStatus(status: string): DisputeStatus {
  switch (status) {
    case 'needs_response':
    case 'warning_needs_response':
      return 'needs_response';
    case 'under_review':
    case 'warning_under_review':
      return 'under_review';
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    default:
      return 'closed';
  }
}

export function mapDispute(dispute: StripeDisputeLike): ProviderDispute {
  return {
    id: dispute.id,
    paymentId: idOf(dispute.payment_intent) ?? '',
    amount: dispute.amount,
    currency: dispute.currency,
    status: toDisputeStatus(dispute.status),
    providerStatus: dispute.status,
    reason: dispute.reason ?? null,
    evidenceDueBy: fromUnix(dispute.evidence_details?.due_by),
    evidenceSubmitted: (dispute.evidence_details?.submission_count ?? 0) > 0,
  };
}

export function mapTransfer(transfer: StripeTransferLike): ProviderTransfer {
  return {
    id: transfer.id,
    reference: transfer.metadata?.plumbus_transfer_id ?? null,
    destinationAccountId: idOf(transfer.destination) ?? '',
    amount: transfer.amount,
    currency: transfer.currency,
    amountReversed: transfer.amount_reversed ?? 0,
    transferGroup: transfer.transfer_group ?? null,
    sourcePaymentId: transfer.metadata?.plumbus_source_payment_id ?? null,
    livemode: transfer.livemode,
  };
}

const PAYOUT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_transit',
  'paid',
  'failed',
  'canceled',
]);

export function mapPayout(payout: StripePayoutLike): ProviderPayout {
  return {
    id: payout.id,
    amount: payout.amount,
    currency: payout.currency,
    status: (PAYOUT_STATUSES.has(payout.status) ? payout.status : 'pending') as PayoutStatus,
    method: payout.method === 'instant' ? 'instant' : 'standard',
    arrivalDate: fromUnix(payout.arrival_date),
    failureCode: payout.failure_code ?? null,
    livemode: payout.livemode,
  };
}

export interface StripeBalanceSettingsLike {
  payments?: {
    payouts?: {
      schedule?: {
        interval?: string | null;
        weekly_payout_days?: string[] | null;
        monthly_payout_days?: number[] | null;
      } | null;
    } | null;
    settlement_timing?: { delay_days?: number; delay_days_override?: number | null } | null;
  } | null;
}

const WEEKDAYS: ReadonlySet<string> = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
]);

export function mapPayoutSchedule(settings: StripeBalanceSettingsLike): PayoutSchedule {
  const schedule = settings.payments?.payouts?.schedule;
  const raw = schedule?.interval;
  const interval =
    raw === 'manual' || raw === 'weekly' || raw === 'monthly' || raw === 'daily' ? raw : 'daily';
  const result: PayoutSchedule = { interval };
  const delay = settings.payments?.settlement_timing?.delay_days;
  if (typeof delay === 'number') result.delayDays = delay;
  const weekday = schedule?.weekly_payout_days?.[0];
  if (interval === 'weekly' && weekday && WEEKDAYS.has(weekday)) {
    result.weeklyAnchor = weekday as NonNullable<PayoutSchedule['weeklyAnchor']>;
  }
  const monthDay = schedule?.monthly_payout_days?.[0];
  if (interval === 'monthly' && monthDay) result.monthlyAnchor = monthDay;
  return result;
}
