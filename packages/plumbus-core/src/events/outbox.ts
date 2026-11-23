import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Outbox table — stores events written atomically alongside business data.
 * A background dispatcher polls pending rows and publishes them to the queue.
 */
export const outboxTable = pgTable(
  'event_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: text('event_type').notNull(),
    version: text('version').notNull().default('1'),
    payload: jsonb('payload').notNull(),
    actor: text('actor').notNull(),
    tenantId: text('tenant_id'),
    traceparent: text('traceparent'),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').notNull().default('pending'), // pending | processing | retry | dispatched | dead_lettered
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    retryCount: text('retry_count').notNull().default('0'),
    lastError: text('last_error'),
  },
  (table) => [
    index('event_outbox_status_idx').on(table.status),
    index('event_outbox_occurred_at_idx').on(table.occurredAt),
    // The retention sweep's scan of dispatched rows (`frameworkRetention.eventOutbox`). The
    // predicate is a literal, as the sweep's is, so the planner can prove the query implies it.
    index('event_outbox_dispatched_idx').on(table.dispatchedAt).where(sql`status = 'dispatched'`),
  ],
);

/**
 * Idempotency table — tracks which event+consumer pairs have been processed
 * to support at-least-once delivery with consumer deduplication.
 */
export const idempotencyTable = pgTable(
  'event_idempotency',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: text('event_id').notNull(),
    consumerId: text('consumer_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('event_idempotency_event_consumer_idx').on(table.eventId, table.consumerId),
    // The retention sweep's scan by age (`frameworkRetention.eventIdempotency`).
    index('event_idempotency_processed_idx').on(table.processedAt),
  ],
);

/**
 * Dead-letter table — events that exhausted retries.
 */
export const deadLetterTable = pgTable(
  'event_dead_letter',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    consumerId: text('consumer_id'),
    lastError: text('last_error'),
    retryCount: text('retry_count').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).defaultNow().notNull(),
    /** Delivery context, and once resolved `resolvedAt` / `resolvedBy` / `resolution` / `note`. */
    metadata: jsonb('metadata'),
  },
  (table) => [
    // Unresolved dead letters by event: the idempotency retention keeps an event's rows while
    // one of them is unresolved, and reads only those.
    index('event_dead_letter_unresolved_idx')
      .on(table.eventId)
      .where(sql`(metadata->>'resolvedAt') IS NULL`),
    // The retention sweep's scan of resolved dead letters (`frameworkRetention.eventDeadLetter`).
    index('event_dead_letter_resolved_idx')
      .on(sql`(${table.metadata}->>'resolvedAt')`)
      .where(sql`(metadata->>'resolvedAt') IS NOT NULL`),
  ],
);
