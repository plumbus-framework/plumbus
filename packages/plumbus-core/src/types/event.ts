import type { z } from 'zod';

// ── Event Definition ──
export interface EventDefinition<TPayload extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description?: string;
  domain?: string;
  version?: string;
  tags?: string[];

  payload: TPayload;
}

// ── Event Envelope (runtime representation of a dispatched event) ──
export interface EventEnvelope<TPayload = unknown> {
  id: string;
  eventType: string;
  version: string;
  occurredAt: Date;
  actor: string;
  tenantId?: string;
  correlationId: string;
  causationId?: string;
  payload: TPayload;
  /**
   * Optional delivery metadata (not written to outbox). Used for trusted ops
   * replay paths that bypass outbox tenant binding.
   */
  metadata?: Record<string, unknown>;
}

/** Actors allowed to deliver events without a matching outbox row (ops replay). */
export const TrustedReplayActor = {
  OpsRetry: 'ops-retry',
  OutboxReplay: 'outbox-replay',
} as const;
