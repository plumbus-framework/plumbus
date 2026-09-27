// ── Stripe objects → neutral payments shapes ──
// Structural "…Like" types name only the fields this adapter reads, so the
// mapping is easy to test with plain fixtures and robust to SDK type churn.

import type {
  ChargeStatus,
  DisputeStatus,
  MerchantDashboard,
  ProviderCharge,
  ProviderDispute,
  ProviderMerchantAccount,
  ProviderRefund,
  RefundStatus,
  Responsibility,
} from '@plumbus/payments';

interface CapabilityStatusLike {
  status?: string;
  status_details?: Array<{ code?: string }>;
}

export interface StripeAccountLike {
  id: string;
  closed?: boolean;
  dashboard?: string | null;
  livemode: boolean;
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
  } | null;
  requirements?: {
    entries?: Array<{
      description?: string;
      awaiting_action_from?: string;
      minimum_deadline?: { status?: string } | null;
    }> | null;
  } | null;
}

export interface StripeChargeObjectLike {
  id: string;
  amount_refunded?: number;
  created?: number;
}

export interface StripePaymentIntentLike {
  id: string;
  status?: string;
  application_fee_amount?: number | null;
  metadata?: Record<string, string> | null;
  latest_charge?: string | StripeChargeObjectLike | null;
}

export interface StripeSessionLike {
  id: string;
  status?: string | null;
  payment_status?: string | null;
  url?: string | null;
  expires_at?: number | null;
  amount_total?: number | null;
  currency?: string | null;
  livemode: boolean;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  payment_intent?: string | StripePaymentIntentLike | null;
}

export interface StripeRefundLike {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  reason?: string | null;
  failure_reason?: string | null;
  metadata?: Record<string, string> | null;
  payment_intent?: string | { id: string } | null;
  charge?: string | { id: string } | null;
}

export interface StripeDisputeLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason?: string | null;
  payment_intent?: string | { id: string } | null;
  evidence_details?: { due_by?: number | null } | null;
}

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

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
  const capabilities = account.configuration?.merchant?.capabilities;
  const cards = capabilities?.card_payments;
  const payouts = capabilities?.stripe_balance?.payouts;
  const due: string[] = [];
  const pastDue: string[] = [];
  for (const entry of account.requirements?.entries ?? []) {
    const status = entry.minimum_deadline?.status;
    const label = entry.description ?? 'Additional information';
    if (entry.awaiting_action_from === 'stripe') continue;
    if (status === 'currently_due' || status === 'past_due') due.push(label);
    if (status === 'past_due') pastDue.push(label);
  }
  const restricted = cards?.status === 'restricted' || cards?.status === 'unsupported';
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
    payoutsEnabled: payouts?.status === 'active',
    requirementsDue: due,
    requirementsPastDue: pastDue,
    disabledReason: restricted ? (cards?.status_details?.[0]?.code ?? cards?.status ?? null) : null,
    closed: account.closed === true,
    livemode: account.livemode,
  };
}

function chargeStatus(
  session: StripeSessionLike,
  intent: StripePaymentIntentLike | null,
): ChargeStatus {
  if (session.status === 'expired') return 'expired';
  if (session.status !== 'complete') return 'open';
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    return 'paid';
  }
  if (intent?.status === 'requires_payment_method' || intent?.status === 'canceled') {
    return 'failed';
  }
  return 'processing';
}

export function mapSession(session: StripeSessionLike): ProviderCharge {
  const intent =
    session.payment_intent && typeof session.payment_intent === 'object'
      ? session.payment_intent
      : null;
  const latest =
    intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const status = chargeStatus(session, intent);
  return {
    id: session.id,
    reference: session.client_reference_id ?? session.metadata?.plumbus_charge_id ?? null,
    paymentId: idOf(session.payment_intent ?? null),
    status,
    amount: session.amount_total ?? 0,
    currency: session.currency ?? '',
    platformFeeAmount: intent?.application_fee_amount ?? 0,
    amountRefunded: latest?.amount_refunded ?? 0,
    url: status === 'open' ? (session.url ?? null) : null,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
    paidAt: status === 'paid' && latest?.created ? new Date(latest.created * 1000) : null,
    clientEmail: session.customer_details?.email ?? session.customer_email ?? null,
    livemode: session.livemode,
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
    paymentId: idOf(refund.payment_intent ?? null) ?? '',
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
  const due = dispute.evidence_details?.due_by;
  return {
    id: dispute.id,
    paymentId: idOf(dispute.payment_intent ?? null) ?? '',
    amount: dispute.amount,
    currency: dispute.currency,
    status: toDisputeStatus(dispute.status),
    providerStatus: dispute.status,
    reason: dispute.reason ?? null,
    evidenceDueBy: due ? new Date(due * 1000) : null,
  };
}
