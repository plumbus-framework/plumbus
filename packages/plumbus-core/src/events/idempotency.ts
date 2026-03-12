import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { idempotencyTable } from './outbox.js';

export interface IdempotencyService {
  /** Returns true if this event has already been processed by this consumer */
  isProcessed(eventId: string, consumerId: string): Promise<boolean>;
  /** Mark an event as processed by a consumer */
  markProcessed(eventId: string, consumerId: string): Promise<void>;
}

/**
 * Creates an idempotency service backed by the event_idempotency table.
 * Used by the delivery worker to prevent duplicate event processing.
 */
export function createIdempotencyService(db: PostgresJsDatabase): IdempotencyService {
  return {
    async isProcessed(eventId: string, consumerId: string): Promise<boolean> {
      const rows = await db
        .select({ id: idempotencyTable.id })
        .from(idempotencyTable)
        .where(
          and(eq(idempotencyTable.eventId, eventId), eq(idempotencyTable.consumerId, consumerId)),
        )
        .limit(1);
      return rows.length > 0;
    },

    async markProcessed(eventId: string, consumerId: string): Promise<void> {
      await db.insert(idempotencyTable).values({
        eventId,
        consumerId,
      });
    },
  };
}
