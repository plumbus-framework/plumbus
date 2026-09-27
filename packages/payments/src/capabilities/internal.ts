// ── Internal webhook-processing capabilities ──
// Only the payments service account may run these. The webhook route records a
// verified event (ledger + queued event, one transaction); the worker re-reads
// the provider outside any transaction, then applies the fresh state in one
// transaction that also emits the domain events.

import { randomUUID } from 'node:crypto';
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { PaymentEntityName } from '../entities/index.js';
import { PaymentEventName } from '../events/index.js';
import { applyStateChanges } from '../runtime/apply-state.js';
import { findOne, isUuid, providerEvents } from '../runtime/repos.js';
import { PAYMENTS_WEBHOOK_ACTOR, type PaymentsRuntime } from '../runtime/runtime.js';
import { serializeChange, stateChangeSchema } from './schemas.js';

// `serviceAccounts` only adds callers; `roles: ['system']` is what shuts everyone
// else out (an access policy with no roles lets any signed-in user through).
const serviceOnly = { roles: ['system'], serviceAccounts: [PAYMENTS_WEBHOOK_ACTOR] };

export function createInternalCapabilities(runtime: PaymentsRuntime) {
  const { provider } = runtime;

  const recordProviderEvent = defineCapability({
    name: 'recordProviderEvent',
    kind: 'action',
    domain: 'payments',
    description: 'Internal — store a verified webhook once and queue it for the worker',
    input: z.object({
      provider: z.string(),
      providerEventId: z.string(),
      type: z.string(),
      format: z.enum(['snapshot', 'thin']),
      livemode: z.boolean(),
      occurredAt: z.string(),
      providerAccountId: z.string().nullable(),
      merchantAccountId: z.string().nullable(),
      objectId: z.string().nullable(),
      objectType: z.string().nullable(),
      status: z.enum(['received', 'ignored']),
      ignoredReason: z.string().nullable(),
      payload: z.unknown().optional(),
    }),
    output: z.object({ ledgerId: z.string(), duplicate: z.boolean() }),
    access: serviceOnly,
    effects: {
      data: [PaymentEntityName.ProviderEvent],
      events: [PaymentEventName.ProviderEventReceived],
      external: [],
      ai: false,
    },
    async handler(ctx, input) {
      const ledger = providerEvents(ctx);
      const existing = await findOne(ledger, {
        provider: input.provider,
        providerEventId: input.providerEventId,
      });
      if (existing) return { ledgerId: existing.id, duplicate: true };

      const row = await ledger.create({
        id: randomUUID(),
        tenantId: ctx.auth.tenantId ?? null,
        provider: input.provider,
        providerEventId: input.providerEventId,
        type: input.type,
        format: input.format,
        livemode: input.livemode,
        providerAccountId: input.providerAccountId,
        merchantAccountId: input.merchantAccountId,
        objectId: input.objectId,
        objectType: input.objectType,
        status: input.status,
        ignoredReason: input.ignoredReason,
        occurredAt: new Date(input.occurredAt),
        receivedAt: ctx.time.now(),
        payload: input.payload ?? null,
      });
      if (input.status === 'received') {
        await ctx.events.emit(PaymentEventName.ProviderEventReceived, {
          ledgerId: row.id,
          provider: input.provider,
          providerEventId: input.providerEventId,
          type: input.type,
        });
      }
      return { ledgerId: row.id, duplicate: false };
    },
  });

  const applyProviderState = defineCapability({
    name: 'applyProviderState',
    kind: 'action',
    domain: 'payments',
    description: 'Internal — apply fresh provider state and emit payments events atomically',
    input: z.object({
      ledgerId: z.string(),
      observedAt: z.string(),
      changes: z.array(stateChangeSchema),
    }),
    output: z.object({
      applied: z.number().int(),
      skipped: z.number().int(),
      events: z.number().int(),
    }),
    access: serviceOnly,
    effects: {
      data: [
        PaymentEntityName.MerchantAccount,
        PaymentEntityName.Charge,
        PaymentEntityName.Refund,
        PaymentEntityName.Dispute,
        PaymentEntityName.ProviderEvent,
      ],
      events: [
        PaymentEventName.MerchantUpdated,
        PaymentEventName.ChargePaid,
        PaymentEventName.ChargeFailed,
        PaymentEventName.ChargeExpired,
        PaymentEventName.ChargeRefunded,
        PaymentEventName.RefundFailed,
        PaymentEventName.DisputeOpened,
        PaymentEventName.DisputeUpdated,
        PaymentEventName.DisputeClosed,
      ],
      external: [],
      ai: false,
    },
    async handler(ctx, input) {
      const result = await applyStateChanges(
        ctx,
        provider.id,
        new Date(input.observedAt),
        input.changes,
      );
      await providerEvents(ctx).update(input.ledgerId, {
        status: 'processed',
        processedAt: ctx.time.now(),
        error: null,
      });
      return result;
    },
  });

  const processProviderEvent = defineCapability({
    name: 'processProviderEvent',
    kind: 'eventHandler',
    domain: 'payments',
    description: 'Internal — re-read the provider for a queued webhook and apply the result',
    trigger: { event: PaymentEventName.ProviderEventReceived },
    input: z.object({
      ledgerId: z.string(),
      provider: z.string(),
      providerEventId: z.string(),
      type: z.string(),
    }),
    output: z.object({
      status: z.enum(['processed', 'skipped']),
      changes: z.number().int(),
    }),
    access: serviceOnly,
    effects: {
      data: [PaymentEntityName.ProviderEvent],
      events: [],
      external: [`payments:${provider.id}`],
      capabilities: ['payments.applyProviderState'],
      ai: false,
    },
    async handler(ctx, input) {
      const ledger = providerEvents(ctx);
      const row = isUuid(input.ledgerId) ? await ledger.findById(input.ledgerId) : null;
      if (!row || row.status === 'processed' || row.status === 'ignored') {
        return { status: 'skipped' as const, changes: 0 };
      }
      const observedAt = ctx.time.now();
      let changes: Awaited<ReturnType<typeof provider.resolveEvent>>;
      try {
        changes = await provider.resolveEvent({
          eventId: row.providerEventId,
          type: row.type,
          format: row.format,
          livemode: row.livemode,
          accountId: row.providerAccountId,
          objectId: row.objectId,
          objectType: row.objectType,
        });
      } catch (err) {
        await ledger.update(row.id, {
          status: 'failed',
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        });
        throw err;
      }
      await ctx.capabilities.invoke('payments.applyProviderState', {
        ledgerId: row.id,
        observedAt: observedAt.toISOString(),
        changes: changes.map(serializeChange),
      });
      return { status: 'processed' as const, changes: changes.length };
    },
  });

  return { recordProviderEvent, applyProviderState, processProviderEvent };
}
