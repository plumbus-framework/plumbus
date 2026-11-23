// ── Event dead-letter resolution ──
// An `event_dead_letter` row stays until someone settles it: the event was published again
// (`plumbus events dead-letter retry`, which marks it `retried`; a delivery that fails again
// writes a new dead letter), or an operator decided nothing needs redoing (`discarded`). The
// mark lives in the row's `metadata` (`resolvedAt`, `resolvedBy`, `resolution`, `note`), so no
// column is added. Framework retention deletes resolved rows once `eventDeadLetter` is on and
// their period has passed; unresolved rows are never deleted.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';

/** How a dead letter was settled. */
export const EventDeadLetterResolution = {
  /** The event was published again; a failing delivery writes a new dead letter. */
  Retried: 'retried',
  /** An operator decided the delivery need not be redone. */
  Discarded: 'discarded',
} as const;
export type EventDeadLetterResolution =
  (typeof EventDeadLetterResolution)[keyof typeof EventDeadLetterResolution];

export interface ResolveEventDeadLetterOptions {
  /** Who settled it (an operator id, `cli`). */
  actor: string;
  /** Default `discarded`. */
  resolution?: EventDeadLetterResolution;
  /** Free text kept on the row. */
  note?: string;
}

const optionsSchema = z
  .object({
    actor: z.string().trim().min(1).max(200),
    resolution: z.enum(['retried', 'discarded']).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

/**
 * Mark one `event_dead_letter` row resolved on `db` (the database that holds it: the pool's,
 * or the tenant plane the delivery ran on). Returns `false` when no unresolved row has that
 * id — unknown, or already resolved (the first resolution is kept).
 */
export async function resolveEventDeadLetter(
  db: PostgresJsDatabase,
  deadLetterId: string,
  options: ResolveEventDeadLetterOptions,
): Promise<boolean> {
  if (!z.string().guid().safeParse(deadLetterId).success) {
    throw new DataValidationError('Event dead-letter id must be a UUID', { deadLetterId });
  }
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new DataValidationError('Invalid event dead-letter resolution', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.message),
    });
  }
  const { actor, resolution = EventDeadLetterResolution.Discarded, note } = parsed.data;
  const mark = {
    resolvedAt: new Date().toISOString(),
    resolvedBy: actor,
    resolution,
    ...(note !== undefined ? { note } : {}),
  };
  const rows = await db.execute(sql`
    UPDATE event_dead_letter
    SET metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(mark)}::jsonb
    WHERE id = ${deadLetterId}::uuid
      AND (metadata->>'resolvedAt') IS NULL
    RETURNING id
  `);
  return Array.isArray(rows) ? rows.length > 0 : (rows as { count?: number }).count === 1;
}

/** Which unresolved dead letters `resolveEventDeadLetters` settles. */
export interface EventDeadLetterFilter {
  /** Only rows of this event type. */
  eventType?: string;
  /** Only rows of this consumer. */
  consumerId?: string;
  /** Only rows that failed before this instant. */
  failedBefore?: Date;
  /** Most rows one call settles (default 1000, at most 10,000). Call again while it returns this many. */
  limit?: number;
}

const filterSchema = z
  .object({
    eventType: z.string().trim().min(1).max(500).optional(),
    consumerId: z.string().trim().min(1).max(500).optional(),
    failedBefore: z.date().optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

/**
 * Mark unresolved `event_dead_letter` rows on `db` that match `filter` resolved, oldest first,
 * at most `filter.limit` (default 1000) in one statement. For settling a pile of dead letters
 * nobody will redeliver (say, events another relay owned) so retention can remove them. Rows
 * already resolved keep their first resolution. Returns how many rows it marked; call again
 * while that equals the limit.
 */
export async function resolveEventDeadLetters(
  db: PostgresJsDatabase,
  filter: EventDeadLetterFilter,
  options: ResolveEventDeadLetterOptions,
): Promise<number> {
  const parsedFilter = filterSchema.safeParse(filter);
  if (!parsedFilter.success) {
    throw new DataValidationError('Invalid event dead-letter filter', {
      issues: parsedFilter.error.issues.map((issue) => issue.path.join('.') || issue.message),
    });
  }
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new DataValidationError('Invalid event dead-letter resolution', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.message),
    });
  }
  const { eventType, consumerId, failedBefore, limit = 1000 } = parsedFilter.data;
  const { actor, resolution = EventDeadLetterResolution.Discarded, note } = parsed.data;
  const mark = {
    resolvedAt: new Date().toISOString(),
    resolvedBy: actor,
    resolution,
    ...(note !== undefined ? { note } : {}),
  };
  const conditions = [sql`(metadata->>'resolvedAt') IS NULL`];
  if (eventType !== undefined) conditions.push(sql`event_type = ${eventType}`);
  if (consumerId !== undefined) conditions.push(sql`consumer_id = ${consumerId}`);
  if (failedBefore !== undefined) {
    conditions.push(sql`failed_at < ${failedBefore.toISOString()}::timestamptz`);
  }
  // The rows are picked once, in a materialized CTE. As `WHERE id IN (SELECT … LIMIT n FOR
  // UPDATE)` the subquery may be run again during the update, see the rows this statement just
  // marked as no longer matching, and pick more: more than `limit` rows changed (seen in testing).
  const rows = await db.execute(sql`
    WITH picked AS MATERIALIZED (
      SELECT id FROM event_dead_letter
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY failed_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE event_dead_letter AS d
    SET metadata = coalesce(d.metadata, '{}'::jsonb) || ${JSON.stringify(mark)}::jsonb
    FROM picked
    WHERE d.id = picked.id
      AND (d.metadata->>'resolvedAt') IS NULL
    RETURNING d.id
  `);
  return Array.isArray(rows) ? rows.length : Number((rows as { count?: number }).count ?? 0);
}
