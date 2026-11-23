// ── Audit outbox ──
// Audit records of work done in a transaction on one database (a tenant's data plane) whose
// audit ledger lives on another (the spine). Without it the record is either written to the
// ledger while the transaction is still open (a second connection held across a round trip, and
// a "success" record that stays when the transaction rolls back) or written after the commit
// (lost if the process stops in between or the ledger is down for long).
//
// With it, `bind(tx)` writes each success record into `audit_outbox` on the transaction itself:
// it commits with the work or rolls back with it, and no second connection is taken. After the
// commit, `flush(db)` hands this unit's records to the ledger at once; anything it could not
// hand over stays in the table and the worker's relay (`relayAuditOutbox`) delivers it later.
// A record keeps its id end to end and the ledger insert ignores an id it already has, so a
// record handed over twice is stored once.

import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createErrorService } from '../errors/index.js';
import type { AuditBatchEntry, AuditEvent, AuditService, AuditWriter } from '../types/audit.js';
import type { AuditWriteFailure } from './service.js';
import { defaultAuditServiceInternals } from './service.js';

/** The outbox table (unqualified, beside `audit_records` and `event_outbox`). */
export const AUDIT_OUTBOX_TABLE = 'audit_outbox';

export const auditOutboxTable = pgTable(
  AUDIT_OUTBOX_TABLE,
  {
    /** The audit record's own id: the ledger row gets the same one. */
    id: uuid('id').primaryKey(),
    /** The whole record (`AuditEvent`, timestamp as ISO text). */
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** Not before this time may the relay take the row (the committer's flush goes first). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
  },
  (t) => [index('audit_outbox_due_idx').on(t.nextAttemptAt)],
);

/** Hand-written DDL of `audit_outbox` (the generated migration creates the same table). */
export function auditOutboxDdl(): string {
  return `
CREATE TABLE audit_outbox (
  id uuid PRIMARY KEY,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX audit_outbox_due_idx ON audit_outbox (next_attempt_at);
`;
}

/** How long the committer's own flush has before the relay may take a row. */
export const AUDIT_OUTBOX_GRACE_MS = 30_000;
/** Longest wait between relay attempts of one row. */
const MAX_RETRY_DELAY_MS = 600_000;
/** How long a flush or relay holds rows it took before another may take them. */
const CLAIM_LEASE_MS = 60_000;

function serialise(event: AuditEvent): Record<string, unknown> {
  return { ...event, timestamp: (event.timestamp ?? new Date()).toISOString() };
}

function deserialise(record: unknown): AuditEvent {
  const raw = record as Record<string, unknown>;
  return {
    ...(raw as unknown as AuditEvent),
    timestamp: typeof raw.timestamp === 'string' ? new Date(raw.timestamp) : new Date(),
  };
}

/** PostgreSQL's "relation does not exist", directly or as a driver error's cause. */
function isMissingTable(error: unknown): boolean {
  const codeOf = (value: unknown) => (value as { code?: unknown } | null)?.code;
  return (
    codeOf(error) === '42P01' || codeOf((error as { cause?: unknown } | null)?.cause) === '42P01'
  );
}

async function insertRows(tx: PostgresJsDatabase, events: AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await insertRowsOnce(tx, events);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    throw createErrorService().internal(
      'audit_outbox is missing on this database: run `plumbus migrate generate` for its migration stream and apply it',
      { reason: 'audit-outbox-missing', cause: error },
    );
  }
}

async function insertRowsOnce(tx: PostgresJsDatabase, events: AuditEvent[]): Promise<void> {
  await tx.insert(auditOutboxTable).values(
    events.map((event) => ({
      id: event.id ?? crypto.randomUUID(),
      record: serialise(event),
      nextAttemptAt: sql`now() + ${`${AUDIT_OUTBOX_GRACE_MS} milliseconds`}::interval`,
    })),
  );
}

/** Take rows by id (only those that exist: a rolled-back unit has none) for a short lease. */
async function claimByIds(db: PostgresJsDatabase, ids: string[]): Promise<AuditEvent[]> {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    UPDATE audit_outbox
    SET next_attempt_at = now() + ${`${CLAIM_LEASE_MS} milliseconds`}::interval
    WHERE id = ANY(${sql.param(ids)}::uuid[])
    RETURNING id, record
  `)) as unknown as Array<{ id: string; record: unknown }>;
  return rows.map((row) => ({ ...deserialise(row.record), id: String(row.id) }));
}

async function deleteByIds(db: PostgresJsDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`DELETE FROM audit_outbox WHERE id = ANY(${sql.param(ids)}::uuid[])`);
}

async function noteFailure(db: PostgresJsDatabase, ids: string[], error: unknown): Promise<void> {
  if (ids.length === 0) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  await db.execute(sql`
    UPDATE audit_outbox SET last_error = ${message}
    WHERE id = ANY(${sql.param(ids)}::uuid[])
  `);
}

async function writeAll(writer: AuditWriter, events: AuditEvent[]): Promise<void> {
  if (writer.writeMany) {
    await writer.writeMany(events);
    return;
  }
  for (const event of events) await writer.write(event);
}

/** What one `flush` did. */
export interface AuditOutboxFlushResult {
  /** Records handed to the ledger and removed from the outbox. */
  delivered: number;
  /** Records left in the outbox for the relay (the ledger refused or was unreachable). */
  left: number;
}

/** Audit records of one unit of work, held in that unit's transaction. */
export interface AuditOutbox {
  /**
   * The audit service to use inside the transaction `tx` (pass it to repositories and to code
   * that records). `success` records go into `audit_outbox` on `tx` and commit or roll back with
   * the work. `failure` and `denied` records are written to the ledger at once, as they must
   * stand whatever happens to the transaction. May be called again for another transaction of
   * the same unit.
   */
  bind(tx: PostgresJsDatabase): AuditService;
  /**
   * After the transaction committed: hand this unit's records to the ledger now and remove
   * them from the outbox, on `db` (the same database, outside the transaction). Never throws:
   * a record it cannot hand over stays for the relay and is reported (`onWriteFailure` of the
   * outer service, `final: false`). Records of a transaction that rolled back do not exist and
   * are not written, so calling it after a rollback does nothing.
   */
  flush(db: PostgresJsDatabase): Promise<AuditOutboxFlushResult>;
}

/**
 * An audit outbox over `outer`, a default audit service (`createAuditService` without a custom
 * `writer`, e.g. `ctx.audit`): its records keep `outer`'s actor, tenant and component and are
 * delivered to `outer`'s `audit_records`. `undefined` for any other service, which the caller
 * keeps using as before.
 *
 * Run the worker's relay (`workers.auditOutboxRelay`) where records are delivered to the
 * worker pool's database (the spine), so records a flush could not hand over still arrive.
 */
export function createAuditOutbox(outer: AuditService): AuditOutbox | undefined {
  const found = defaultAuditServiceInternals(outer);
  if (!found) return undefined;
  const internals = found;
  const ids: string[] = [];

  return {
    bind(tx: PostgresJsDatabase): AuditService {
      async function record(events: AuditEvent[]): Promise<void> {
        const success = events.filter((event) => event.outcome === 'success');
        const others = events.filter((event) => event.outcome !== 'success');
        if (success.length > 0) {
          await insertRows(tx, success);
          for (const event of success) if (event.id) ids.push(event.id);
        }
        if (others.length > 0) await internals.write(others);
      }
      return {
        async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
          await record([internals.buildEvent(eventType, metadata)]);
        },
        async recordMany(entries: AuditBatchEntry[]): Promise<void> {
          await record(
            entries.map((entry) => internals.buildEvent(entry.eventType, entry.metadata)),
          );
        },
      };
    },

    async flush(db: PostgresJsDatabase): Promise<AuditOutboxFlushResult> {
      const pending = ids.splice(0);
      if (pending.length === 0) return { delivered: 0, left: 0 };
      let events: AuditEvent[];
      try {
        events = await claimByIds(db, pending);
      } catch (error) {
        internals.reportFailure({ events: [], error, final: false, attempts: 1 });
        return { delivered: 0, left: pending.length };
      }
      if (events.length === 0) return { delivered: 0, left: 0 };
      try {
        await internals.write(events);
      } catch (error) {
        await noteFailure(
          db,
          events.map((event) => event.id as string),
          error,
        ).catch(() => undefined);
        internals.reportFailure({ events, error, final: false, attempts: 1 });
        return { delivered: 0, left: events.length };
      }
      try {
        await deleteByIds(
          db,
          events.map((event) => event.id as string),
        );
      } catch {
        // Delivered; the relay finds the rows, writes nothing twice (same ids) and removes them.
      }
      return { delivered: events.length, left: 0 };
    },
  };
}

/**
 * Run `work` in a transaction on `db` with an audit outbox over `outer`, then flush it once the
 * transaction committed. `work` receives the transaction and the audit service to record with.
 * With a non-default `outer` (no outbox possible), `work` gets `outer` itself.
 */
export async function runWithAuditOutbox<T>(
  outer: AuditService,
  db: PostgresJsDatabase,
  work: (tx: PostgresJsDatabase, audit: AuditService) => Promise<T>,
): Promise<T> {
  const outbox = createAuditOutbox(outer);
  if (!outbox) return db.transaction((tx) => work(tx as unknown as PostgresJsDatabase, outer));
  const result = await db.transaction((tx) =>
    work(tx as unknown as PostgresJsDatabase, outbox.bind(tx as unknown as PostgresJsDatabase)),
  );
  await outbox.flush(db);
  return result;
}

const tablePresence = new WeakMap<object, Promise<boolean>>();

/** Whether `audit_outbox` exists on `db` (asked once per handle; a failed probe asks again). */
export function auditOutboxAvailable(db: PostgresJsDatabase): Promise<boolean> {
  const cached = tablePresence.get(db);
  if (cached) return cached;
  const presence = (async () => {
    const rows = (await db.execute(
      sql`SELECT to_regclass('audit_outbox') IS NOT NULL AS present`,
    )) as unknown as Array<{ present: boolean }>;
    return Array.isArray(rows) && rows[0]?.present === true;
  })();
  tablePresence.set(db, presence);
  return presence.catch(() => {
    tablePresence.delete(db);
    return false;
  });
}

export interface RelayAuditOutboxOptions {
  /** Where the records go: the ledger's writer (`createDatabaseAuditWriter(spineDb)`). */
  writer: AuditWriter;
  /** Rows per call (default 500). */
  limit?: number;
  /** Told when a batch could not be delivered (it stays and is retried with a back-off). */
  onWriteFailure?: (failure: AuditWriteFailure) => void;
}

/** What one relay call did. */
export interface RelayAuditOutboxResult {
  delivered: number;
  failed: number;
}

/**
 * Deliver due `audit_outbox` rows of `db` to `options.writer`, once: take up to `limit` rows
 * (`FOR UPDATE SKIP LOCKED`, pushing each row's next attempt out with a back-off in the same
 * statement), write them with their ids, then delete them. A batch the writer refuses stays,
 * with its error, for the next attempt; nothing is ever dropped. A database without the table
 * relays nothing.
 */
export async function relayAuditOutbox(
  db: PostgresJsDatabase,
  options: RelayAuditOutboxOptions,
): Promise<RelayAuditOutboxResult> {
  if (!(await auditOutboxAvailable(db))) return { delivered: 0, failed: 0 };
  const limit = options.limit ?? 500;
  // Picked once in a materialized CTE: as `WHERE id IN (SELECT … LIMIT n FOR UPDATE)` the
  // subquery may run again during the update and pick rows past the limit.
  const rows = (await db.execute(sql`
    WITH picked AS MATERIALIZED (
      SELECT id FROM audit_outbox
      WHERE next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE audit_outbox AS o
    SET attempts = o.attempts + 1,
        next_attempt_at = now() + make_interval(secs => least(
          ${MAX_RETRY_DELAY_MS / 1000}::double precision,
          ${CLAIM_LEASE_MS / 1000}::double precision * power(2, o.attempts)
        ))
    FROM picked
    WHERE o.id = picked.id
    RETURNING o.id, o.record, o.attempts
  `)) as unknown as Array<{ id: string; record: unknown; attempts: number }>;
  if (rows.length === 0) return { delivered: 0, failed: 0 };
  const events = rows.map((row) => ({ ...deserialise(row.record), id: String(row.id) }));
  const ids = events.map((event) => event.id as string);
  try {
    await writeAll(options.writer, events);
  } catch (error) {
    await noteFailure(db, ids, error);
    try {
      options.onWriteFailure?.({
        events,
        error,
        final: false,
        attempts: Math.max(...rows.map((row) => Number(row.attempts))),
      });
    } catch {
      // A failing reporter must not stop the relay.
    }
    return { delivered: 0, failed: events.length };
  }
  await deleteByIds(db, ids);
  return { delivered: events.length, failed: 0 };
}
