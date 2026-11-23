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
