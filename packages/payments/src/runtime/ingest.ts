// ── Webhook ingest ──
// Shared by the Fastify route and the test helper: decide whether a verified
// event is ours and which tenant it belongs to, then record it once (and queue
// it) through recordProviderEvent.
//
// Events from a seller's account carry that account; the seller row names the
// tenant. Events from the platform account (destination and platform charges,
// the platform's own plans) carry no seller: their tenant comes from the
// metadata this package stamps on every object, or from the local row of the
// customer, payment, or subscription they concern.

import type { AuthContext, ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { ProviderEventRouting, VerifiedProviderEvent } from '../types/provider.js';
import type { PaymentMerchantAccountRow } from '../types/records.js';
import type { Payments } from './create-payments.js';
import {
  billingCustomers,
  charges,
  clients,
  findOne,
  merchantAccounts,
  providerEvents,
  subscriptions,
} from './repos.js';
import { PAYMENTS_WEBHOOK_ACTOR } from './runtime.js';

export interface IngestOutcome {
  status: 'received' | 'ignored';
  ignoredReason: string | null;
  duplicate: boolean;
  ledgerId: string | null;
  tenantId: string | null;
}

/** Auth for the payments service account, optionally bound to one tenant. */
export function paymentsServiceAuth(tenantId?: string): AuthContext {
  return {
    userId: PAYMENTS_WEBHOOK_ACTOR,
    roles: ['system'],
    scopes: [],
    provider: PAYMENTS_WEBHOOK_ACTOR,
    ...(tenantId ? { tenantId } : {}),
  };
}

/** Cross-tenant lookups ingest needs, run with the tenant scope bypassed. */
export interface IngestLookups {
  findSeller(accountId: string): Promise<PaymentMerchantAccountRow | null>;
  findTenant(routing: ProviderEventRouting): Promise<string | null>;
}

/** Lookups over a context that sees every tenant (tenant scope bypassed). */
export function crossTenantLookups(ctx: ExecutionContext, provider: string): IngestLookups {
  return {
    findSeller: (accountId) =>
      findOne(merchantAccounts(ctx), { provider, providerAccountId: accountId }),
    async findTenant(routing) {
      if (routing.tenantId) return routing.tenantId;
      const candidates: Array<() => Promise<{ tenantId?: string | null } | null>> = [];
      if (routing.customerId) {
        const customerId = routing.customerId;
        candidates.push(() =>
          findOne(billingCustomers(ctx), { provider, providerCustomerId: customerId }),
        );
        candidates.push(() => findOne(clients(ctx), { provider, providerClientId: customerId }));
      }
      if (routing.paymentId) {
        const paymentId = routing.paymentId;
        candidates.push(() => findOne(charges(ctx), { provider, providerPaymentId: paymentId }));
      }
      if (routing.subscriptionId) {
        const subscriptionId = routing.subscriptionId;
        candidates.push(() =>
          findOne(subscriptions(ctx), { provider, providerSubscriptionId: subscriptionId }),
        );
      }
      for (const candidate of candidates) {
        const row = await candidate();
        if (row?.tenantId) return row.tenantId;
      }
      return null;
    },
  };
}

export async function ingestProviderEvent(args: {
  payments: Payments;
  event: VerifiedProviderEvent;
  lookups: IngestLookups;
  /** A context running as the payments service account for `tenantId`. */
  contextFor: (tenantId?: string) => ExecutionContext;
}): Promise<IngestOutcome> {
  const { payments, event, lookups } = args;
  const { provider, config } = payments;

  const livemode = await provider.resolveLivemode();
  let ignoredReason: string | null = null;
  let merchant: PaymentMerchantAccountRow | null = null;
  let tenantId: string | null = null;
  if (event.livemode !== livemode) {
    ignoredReason = 'livemode_mismatch';
  } else if (!provider.isRelevantEvent(event)) {
    ignoredReason = 'unhandled_type';
  } else if (event.accountId) {
    merchant = await lookups.findSeller(event.accountId);
    tenantId = merchant?.tenantId ?? null;
    if (!merchant) ignoredReason = 'unknown_seller_account';
  } else {
    tenantId = await lookups.findTenant(event.routing);
    if (!tenantId) ignoredReason = 'unknown_platform_object';
  }
  const status = ignoredReason ? ('ignored' as const) : ('received' as const);

  const ctx = args.contextFor(tenantId ?? undefined);
  const result = await executeCapability(payments.capabilities.recordProviderEvent, ctx, {
    provider: provider.id,
    providerEventId: event.eventId,
    type: event.type,
    format: event.format,
    livemode: event.livemode,
    occurredAt: event.occurredAt.toISOString(),
    providerAccountId: event.accountId,
    merchantAccountId: merchant?.id ?? null,
    objectId: event.objectId,
    objectType: event.objectType,
    status,
    ignoredReason,
    ...(config.webhooks.storePayload ? { payload: event.payload } : {}),
  });
  if (result.success) {
    return {
      status,
      ignoredReason,
      duplicate: result.data.duplicate,
      ledgerId: result.data.ledgerId,
      tenantId,
    };
  }
  // Two deliveries of one event can race on the unique index; the loser is a duplicate.
  const winner = await findOne(providerEvents(ctx), {
    provider: provider.id,
    providerEventId: event.eventId,
  });
  if (winner) return { status, ignoredReason, duplicate: true, ledgerId: winner.id, tenantId };
  throw result.error;
}
