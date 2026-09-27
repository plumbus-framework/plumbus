// ── Webhook ingest ──
// Shared by the Fastify route and the test helper: decide whether a verified
// event is ours, then record it once (and queue it) through recordProviderEvent.

import type { AuthContext, ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { VerifiedProviderEvent } from '../types/provider.js';
import type { PaymentMerchantAccountRow } from '../types/records.js';
import type { Payments } from './create-payments.js';
import { findOne, providerEvents } from './repos.js';
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

export async function ingestProviderEvent(args: {
  payments: Payments;
  event: VerifiedProviderEvent;
  /** Cross-tenant seller lookup by provider account id. */
  findSeller: (accountId: string) => Promise<PaymentMerchantAccountRow | null>;
  /** A context running as the payments service account for `tenantId`. */
  contextFor: (tenantId?: string) => ExecutionContext;
}): Promise<IngestOutcome> {
  const { payments, event } = args;
  const { provider, config } = payments;

  const livemode = await provider.resolveLivemode();
  let ignoredReason: string | null = null;
  let merchant: PaymentMerchantAccountRow | null = null;
  if (event.livemode !== livemode) {
    ignoredReason = 'livemode_mismatch';
  } else if (!provider.isRelevantEvent(event)) {
    ignoredReason = 'unhandled_type';
  } else if (!event.accountId) {
    ignoredReason = 'no_seller_account';
  } else {
    merchant = await args.findSeller(event.accountId);
    if (!merchant) ignoredReason = 'unknown_seller_account';
  }
  const status = ignoredReason ? ('ignored' as const) : ('received' as const);
  const tenantId = merchant?.tenantId ?? null;

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
