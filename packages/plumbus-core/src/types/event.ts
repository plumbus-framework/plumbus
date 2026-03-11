import type { z } from "zod";

// ── Event Definition ──
export interface EventDefinition<
  TPayload extends z.ZodTypeAny = z.ZodTypeAny,
> {
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
}
