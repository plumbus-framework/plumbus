import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";
import type { AuditService } from "../types/audit.js";
import type { EventService } from "../types/context.js";
import type { EventEnvelope } from "../types/event.js";
import type { AuthContext } from "../types/security.js";
import { outboxTable } from "./outbox.js";
import { EventRegistry } from "./registry.js";

export interface EventEmitterConfig {
  db: PostgresJsDatabase;
  auth: AuthContext;
  registry: EventRegistry;
  audit?: AuditService;
  /** Optional correlation ID propagated from the triggering request/flow */
  correlationId?: string;
  /** Optional causation ID linking to the originating event */
  causationId?: string;
}

/**
 * Create an EventService that validates payloads against registered schemas,
 * writes events to the outbox table (so they can be dispatched transactionally),
 * and records audit entries for each emission.
 */
export function createEventEmitter(config: EventEmitterConfig): EventService {
  const { db, auth, registry, audit, correlationId, causationId } = config;

  return {
    async emit(eventName: string, payload: unknown): Promise<void> {
      // 1. Look up event definition for schema validation
      const eventDef = registry.get(eventName);
      if (eventDef) {
        const parseResult = eventDef.payload.safeParse(payload);
        if (!parseResult.success) {
          throw new Error(
            `Event "${eventName}": invalid payload — ${parseResult.error.message}`,
          );
        }
      }

      // 2. Build envelope metadata
      const envelope: EventEnvelope = {
        id: randomUUID(),
        eventType: eventName,
        version: eventDef?.version ?? "1",
        occurredAt: new Date(),
        actor: auth.userId ?? "anonymous",
        tenantId: auth.tenantId,
        correlationId: correlationId ?? randomUUID(),
        causationId,
        payload: payload as Record<string, unknown>,
      };

      // 3. Write to outbox table (pending for dispatcher pickup)
      await db.insert(outboxTable).values({
        id: envelope.id,
        eventType: envelope.eventType,
        version: envelope.version,
        payload: envelope.payload as any,
        actor: envelope.actor,
        tenantId: envelope.tenantId ?? null,
        correlationId: envelope.correlationId,
        causationId: envelope.causationId ?? null,
        occurredAt: envelope.occurredAt,
        status: "pending",
      });

      // 4. Record audit
      if (audit) {
        await audit.record(`event.emitted.${eventName}`, {
          eventId: envelope.id,
          eventType: eventName,
          actor: envelope.actor,
          tenantId: envelope.tenantId,
          outcome: "success",
        });
      }
    },
  };
}
