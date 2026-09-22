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
  (table) => [index('event_idempotency_event_consumer_idx').on(table.eventId, table.consumerId)],
);

/**
 * Dead-letter table — events that exhausted retries.
 */
export const deadLetterTable = pgTable('event_dead_letter', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  consumerId: text('consumer_id'),
  lastError: text('last_error'),
  retryCount: text('retry_count').notNull(),
  failedAt: timestamp('failed_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata'),
});
