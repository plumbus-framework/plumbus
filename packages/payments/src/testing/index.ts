// ── @plumbus/payments/testing ──
// Test helpers for apps and provider packages: a fake provider, a context with
// every payments entity and capability registered, and a helper that runs a
// signed webhook through the same ingest + worker path production uses.

import type { CapabilityContract, ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import { createTestContext, type TestContextOptions } from '@plumbus/core/testing';
import type { Payments } from '../runtime/create-payments.js';
import { crossTenantLookups, ingestProviderEvent, paymentsServiceAuth } from '../runtime/ingest.js';

export {
  createFakePaymentProvider,
  FAKE_SIGNATURE_HEADER,
  type FakeCall,
  type FakeDelivery,
  type FakePaymentProvider,
  type FakePaymentProviderOptions,
} from './fake-provider.js';

/** A test context with the payments entities and capabilities registered. */
export function createPaymentsTestContext(
  payments: Payments,
  options: TestContextOptions = {},
): ExecutionContext {
  return createTestContext({
    ...options,
    entities: [...(options.entities ?? []), ...payments.entities],
    capabilities: [
      ...(options.capabilities ?? []),
      ...(Object.values(payments.capabilities) as unknown as CapabilityContract[]),
    ],
  });
}

/** `ctx` re-bound to another identity; data, events, and capabilities stay shared. */
export function withAuth(ctx: ExecutionContext, auth: ExecutionContext['auth']): ExecutionContext {
  return { ...ctx, auth };
}

export interface DeliverTestWebhookResult {
  status: 'received' | 'ignored' | 'duplicate' | 'rejected';
  ignoredReason: string | null;
  ledgerId: string | null;
  /** Result of the worker step, when the event was received. */
  processed: { status: string; changes: number } | null;
}

/**
 * Verify, record, and (unless `process: false`) immediately process one webhook
 * delivery, exactly as the route and the worker would. `ctx` must come from
 * createPaymentsTestContext (its in-memory data is shared across identities).
 */
export async function deliverTestWebhook(
  payments: Payments,
  ctx: ExecutionContext,
  delivery: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> },
  options: { process?: boolean } = {},
): Promise<DeliverTestWebhookResult> {
  let event: Awaited<ReturnType<Payments['provider']['verifyWebhook']>>;
  try {
    event = await payments.provider.verifyWebhook(delivery);
  } catch {
    return { status: 'rejected', ignoredReason: null, ledgerId: null, processed: null };
  }

  const outcome = await ingestProviderEvent({
    payments,
    event,
    lookups: crossTenantLookups(withAuth(ctx, paymentsServiceAuth()), payments.provider.id),
    contextFor: (tenantId) => withAuth(ctx, paymentsServiceAuth(tenantId)),
  });
  const status = outcome.duplicate ? 'duplicate' : outcome.status;
  if (status !== 'received' || options.process === false || !outcome.ledgerId) {
    return {
      status,
      ignoredReason: outcome.ignoredReason,
      ledgerId: outcome.ledgerId,
      processed: null,
    };
  }

  const workerCtx = withAuth(ctx, paymentsServiceAuth(outcome.tenantId ?? undefined));
  const result = await executeCapability(payments.capabilities.processProviderEvent, workerCtx, {
    ledgerId: outcome.ledgerId,
    provider: payments.provider.id,
    providerEventId: event.eventId,
    type: event.type,
  });
  if (!result.success) throw result.error;
  return {
    status,
    ignoredReason: outcome.ignoredReason,
    ledgerId: outcome.ledgerId,
    processed: result.data,
  };
}
