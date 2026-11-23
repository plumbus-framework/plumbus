// ── Framework table retention ──
// Deletes finished framework rows that nothing can claim, wait on, replay or dedupe against
// any more, in bounded batches through indexes that match each predicate. Opt-in: the worker
// pool runs it only when given `frameworkRetention` (an `app/server.ts` export under
// `plumbus start` / `plumbus worker` / `plumbus dev`).
//
// What is kept on purpose:
//   • `failed` flow executions and their `flow_dead_letter` rows (operator retry and replay);
//     the durable state of failed executions (an in-place retry reopens it).
//   • anything with a deferred start still pending (`flow_start_intents`).
//   • a flow row whose tenant durable state is not terminal yet.
//   • unacknowledged or unpublished `dispatch_outbox` rows, and spine hints that are not
//     acknowledged (`ready`, `leased`, `retry-scheduled`, `dead-lettered`).
//   • the newest spine hint of each execution, unless the execution's tenant state was
//     pruned in the same run: a request-side engine finds an execution's plane through it.
//   • schedule ticks at or after their schedule's `next_run_at` (the slot dedupe the
//     scheduler relies on when a tick committed but the schedule did not advance).
//   • audit records (app policy; never touched).
//
// Event and job tables (core 0.9.0-beta.15), each off unless its class is set, each with its
// own period (`keepDays` by default), and each skipped on a database without its index:
//   • `eventOutbox`: `event_outbox` rows `dispatched` that long ago. Never `pending`,
//     `processing`, `retry` or `dead_lettered` rows.
//   • `eventIdempotency`: `event_idempotency` rows processed that long ago whose event can no
//     longer be delivered again from this database: no `event_outbox` row with its id (any
//     status: the pump or `plumbus events replay` would publish it again) and no unresolved
//     `event_dead_letter` row for it (`plumbus events dead-letter retry` republishes the event
//     to every consumer, and the ones that already processed it skip it by this row).
//   • `eventDeadLetter`: `event_dead_letter` rows resolved that long ago (`metadata.resolvedAt`,
//     written by `resolveEventDeadLetter` and the CLI's `retry` / `resolve`). Never unresolved.
//   • `jobExecutions`: `job_executions` rows `completed`, `failed` or `dead_lettered` that long
//     ago with no publication pending. Never `queued` or `running`.

import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { DurableExecutionStatus, qualifyTable, SpineDeliveryState } from '../durable/index.js';
import { DataValidationError } from '../errors/index.js';
import { JobExecutionStatus } from '../jobs/schema.js';
import { FlowStatus } from './state-machine.js';

/** Defaults the worker uses for every option left out. */
export const FRAMEWORK_RETENTION_DEFAULTS = Object.freeze({
  keepDays: 30,
  batchSize: 500,
  maxBatchesPerTable: 20,
  intervalMs: 3_600_000,
});

export interface FrameworkRetentionOptions {
  /** Keep finished rows this many days after they finished (default 30, at least 1). */
  keepDays?: number;
  /** Rows deleted per statement (default 500). */
  batchSize?: number;
  /**
   * Statements per table per run (default 20). A table with more due rows than
   * `batchSize × maxBatchesPerTable` continues on the next run.
   */
  maxBatchesPerTable?: number;
  /** How often the worker pool runs the sweep (default one hour). */
  intervalMs?: number;
  /** Dispatched `event_outbox` rows. Off unless set; `true` keeps them `keepDays`. */
  eventOutbox?: FrameworkRetentionClassOption;
  /** `event_idempotency` rows no redelivery can need any more. Off unless set. */
  eventIdempotency?: FrameworkRetentionClassOption;
  /** Resolved `event_dead_letter` rows. Off unless set. */
  eventDeadLetter?: FrameworkRetentionClassOption;
  /** Finished `job_executions` rows. Off unless set. */
  jobExecutions?: FrameworkRetentionClassOption;
}

/** A retention class: on with the run's `keepDays` (`true`), on with its own period, or off. */
export type FrameworkRetentionClassOption = boolean | { keepDays?: number };

/** The event and job retention classes, each off unless set. */
export const FRAMEWORK_RETENTION_CLASSES = Object.freeze([
  'eventOutbox',
  'eventIdempotency',
  'eventDeadLetter',
  'jobExecutions',
] as const);
export type FrameworkRetentionClass = (typeof FRAMEWORK_RETENTION_CLASSES)[number];

export type ResolvedFrameworkRetentionOptions = Required<
  Pick<FrameworkRetentionOptions, 'keepDays' | 'batchSize' | 'maxBatchesPerTable' | 'intervalMs'>
> & {
  /** Present only for a class that is on. */
  [Class in FrameworkRetentionClass]?: { keepDays: number };
};

const keepDaysSchema = z.number().finite().min(1);
const classSchema = z
  .union([z.boolean(), z.object({ keepDays: keepDaysSchema.optional() }).strict()])
  .optional();

const retentionOptionsSchema = z
  .object({
    keepDays: keepDaysSchema.optional(),
    batchSize: z.number().int().min(1).max(10_000).optional(),
    maxBatchesPerTable: z.number().int().min(1).max(10_000).optional(),
    intervalMs: z.number().int().min(1).optional(),
    eventOutbox: classSchema,
    eventIdempotency: classSchema,
    eventDeadLetter: classSchema,
    jobExecutions: classSchema,
  })
  .strict();

/**
 * `true` → the defaults; an object → the defaults overridden; `false` / undefined → off.
 * Throws `DataValidationError` for an option out of range.
 */
export function resolveFrameworkRetentionOptions(
  value: FrameworkRetentionOptions | boolean | undefined,
): ResolvedFrameworkRetentionOptions | undefined {
  if (value === undefined || value === false) return undefined;
  const parsed = retentionOptionsSchema.safeParse(value === true ? {} : value);
  if (!parsed.success) {
    throw new DataValidationError(
      `Invalid frameworkRetention options: ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  const { eventOutbox, eventIdempotency, eventDeadLetter, jobExecutions, ...base } = parsed.data;
  const resolved: ResolvedFrameworkRetentionOptions = { ...FRAMEWORK_RETENTION_DEFAULTS, ...base };
  const classes = { eventOutbox, eventIdempotency, eventDeadLetter, jobExecutions };
  for (const name of FRAMEWORK_RETENTION_CLASSES) {
    const option = classes[name];
    if (option === undefined || option === false) continue;
    resolved[name] = Object.freeze({
      keepDays: option === true ? resolved.keepDays : (option.keepDays ?? resolved.keepDays),
    });
  }
  return Object.freeze(resolved);
}

export interface FrameworkRetentionResult {
  /** `flow_executions` rows deleted (completed or cancelled). */
  flowExecutions: number;
  /** Terminal `execution_state` rows deleted, each with its step, wait, terminal and outbox rows. */
  durableExecutions: number;
  /** Acknowledged `dispatch_outbox` rows of executions still alive. */
  dispatchOutbox: number;
  /** `side_effect_log` rows. */
  sideEffects: number;
  /** `flow_schedule_ticks` rows. */
  scheduleTicks: number;
  /** Acknowledged `opaque_dispatch` hints on the spine. */
  spineHints: number;
  /** Dispatched `event_outbox` rows (present when the class is on). */
  eventOutbox?: number;
  /** `event_idempotency` rows (present when the class is on). */
  eventIdempotency?: number;
  /** Resolved `event_dead_letter` rows (present when the class is on). */
  eventDeadLetters?: number;
  /** Finished `job_executions` rows (present when the class is on). */
  jobExecutions?: number;
  /**
   * Indexes a class that is on needs and this database lacks; the class was skipped here
   * rather than scan its table (run `plumbus migrate generate`). Present when not empty.
   */
  missingIndexes?: string[];
  /** False when a table reached `maxBatchesPerTable` with rows still due. */
  drained: boolean;
}

export interface PruneFrameworkTablesOptions extends FrameworkRetentionOptions {
  /** The plane's framework schema for the durable tables (default `core_plumbus`). */
  coreSchema?: string;
  /**
   * The spine's connection under tenant data planes: the acknowledged hints of executions
   * whose durable state is pruned here are deleted there too.
   */
  spineDb?: PostgresJsDatabase;
}

function asRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Literal state lists: the planner proves a partial index's predicate only from constants. */
const FLOW_PRUNABLE = sql.raw(`(${[FlowStatus.Completed, FlowStatus.Cancelled].map(literal)})`);
const DURABLE_PRUNABLE = sql.raw(
  `(${[DurableExecutionStatus.Succeeded, DurableExecutionStatus.Cancelled].map(literal)})`,
);
const SPINE_ACKNOWLEDGED = sql.raw(literal(SpineDeliveryState.Acknowledged));
const OUTBOX_DISPATCHED = sql.raw(literal('dispatched'));
const JOB_FINISHED = sql.raw(
  `(${[JobExecutionStatus.Completed, JobExecutionStatus.Failed, JobExecutionStatus.DeadLettered].map(literal)})`,
);
/** The expression `event_dead_letter_resolved_idx` is built on. */
const DEAD_LETTER_RESOLVED = sql.raw(`(metadata->>'resolvedAt')`);

async function tableExists(db: PostgresJsDatabase, qualified: string): Promise<boolean> {
  const row = asRows(
    await db.execute(sql`SELECT to_regclass(${qualified}::text) IS NOT NULL AS present`),
  )[0];
  return row?.present === true;
}

async function cutoffOf(db: PostgresJsDatabase, keepDays: number): Promise<string> {
  const row = asRows(
    await db.execute(
      sql`SELECT (now() - make_interval(secs => ${keepDays * 86_400}::double precision))::text AS cutoff`,
    ),
  )[0];
  return String(row?.cutoff);
}

async function inBatches(
  options: ResolvedFrameworkRetentionOptions,
  batch: () => Promise<number>,
): Promise<{ deleted: number; drained: boolean }> {
  let deleted = 0;
  for (let index = 0; index < options.maxBatchesPerTable; index += 1) {
    const count = await batch();
    deleted += count;
    if (count < options.batchSize) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/**
 * One retention pass over one database (the pool's, or one tenant data plane). Every table
 * it does not find is skipped, so a plane without the durable or schedule tables is fine.
 * Safe to run from several processes at once (`FOR UPDATE SKIP LOCKED`).
 */
export async function pruneFrameworkTables(
  db: PostgresJsDatabase,
  options: PruneFrameworkTablesOptions = {},
): Promise<FrameworkRetentionResult> {
  const { coreSchema = FRAMEWORK_SCHEMA, spineDb, ...rest } = options;
  const resolved = resolveFrameworkRetentionOptions(rest) as ResolvedFrameworkRetentionOptions;
  const limit = resolved.batchSize;
  const cutoff = await cutoffOf(db, resolved.keepDays);
  const result: FrameworkRetentionResult = {
    flowExecutions: 0,
    durableExecutions: 0,
    dispatchOutbox: 0,
    sideEffects: 0,
    scheduleTicks: 0,
    spineHints: 0,
    drained: true,
  };
  const note = (outcome: { deleted: number; drained: boolean }): number => {
    if (!outcome.drained) result.drained = false;
    return outcome.deleted;
  };

  const executionState = qualifyTable(coreSchema, 'execution_state');
  const stepExecution = qualifyTable(coreSchema, 'step_execution');
  const waitState = qualifyTable(coreSchema, 'wait_state');
  const terminalState = qualifyTable(coreSchema, 'terminal_state');
  const dispatchOutbox = qualifyTable(coreSchema, 'dispatch_outbox');
  const sideEffectLog = qualifyTable(coreSchema, 'side_effect_log');
  const present = new Map<string, boolean>();
  for (const name of [
    'flow_executions',
    'flow_start_intents',
    'flow_schedule_ticks',
    'flow_schedules',
    executionState,
    stepExecution,
    waitState,
    terminalState,
    dispatchOutbox,
    sideEffectLog,
  ]) {
    present.set(name, await tableExists(db, name));
  }
  const has = (name: string) => present.get(name) === true;

  // 1. Tenant durable state of executions that succeeded or were cancelled, first: the flow
  //    rows below are kept while their durable state is not terminal.
  if (has(executionState)) {
    const children: SQL[] = [];
    for (const table of [stepExecution, waitState, terminalState, dispatchOutbox]) {
      if (has(table)) {
        children.push(
          sql`${sql.raw(`pruned_${children.length}`)} AS (DELETE FROM ${sql.raw(table)} WHERE execution_id IN (SELECT execution_id FROM doomed))`,
        );
      }
    }
    result.durableExecutions = note(
      await inBatches(resolved, async () => {
        const rows = asRows(
          await db.execute(sql`
            WITH doomed AS (
              SELECT execution_id, tenant_ref FROM ${sql.raw(executionState)}
              WHERE terminal = true
                AND status IN ${DURABLE_PRUNABLE}
                AND updated_at < ${cutoff}::timestamptz
              ORDER BY updated_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )${children.length > 0 ? sql`, ${sql.join(children, sql`, `)}` : sql``}
            DELETE FROM ${sql.raw(executionState)}
            WHERE execution_id IN (SELECT execution_id FROM doomed)
            RETURNING execution_id, tenant_ref
          `),
        );
        if (spineDb && rows.length > 0) {
          result.spineHints += await deleteHintsOf(spineDb, rows);
        }
        return rows.length;
      }),
    );
  }

  // 2. Flow executions that completed or were cancelled.
  if (has('flow_executions')) {
    const guards: SQL[] = [];
    if (has('flow_start_intents')) {
      guards.push(
        sql`AND NOT EXISTS (SELECT 1 FROM flow_start_intents i WHERE i.execution_id = f.id)`,
      );
    }
    if (has(executionState)) {
      guards.push(
        sql`AND NOT EXISTS (SELECT 1 FROM ${sql.raw(executionState)} e WHERE e.execution_id = f.id::text AND e.terminal = false)`,
      );
    }
    result.flowExecutions = note(
      await inBatches(
        resolved,
        async () =>
          asRows(
            await db.execute(sql`
            DELETE FROM flow_executions
            WHERE id IN (
              SELECT f.id FROM flow_executions f
              WHERE f.status IN ${FLOW_PRUNABLE}
                AND f.updated_at < ${cutoff}::timestamptz
                ${sql.join(guards, sql` `)}
              ORDER BY f.updated_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
              AND status IN ${FLOW_PRUNABLE}
            RETURNING id
          `),
          ).length,
      ),
    );
  }

  // 3. Acknowledged outbox rows of executions still alive (their hints are done with).
  if (has(dispatchOutbox)) {
    result.dispatchOutbox = note(
      await inBatches(
        resolved,
        async () =>
          asRows(
            await db.execute(sql`
            DELETE FROM ${sql.raw(dispatchOutbox)}
            WHERE outbox_id IN (
              SELECT outbox_id FROM ${sql.raw(dispatchOutbox)}
              WHERE spine_acked_at IS NOT NULL
                AND created_at < ${cutoff}::timestamptz
              ORDER BY created_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING outbox_id
          `),
          ).length,
      ),
    );
  }

  // 4. Side-effect evidence: each key is fenced by the revision it was applied under, which
  //    can never be applied again once the execution has moved past it.
  if (has(sideEffectLog)) {
    result.sideEffects = note(
      await inBatches(
        resolved,
        async () =>
          asRows(
            await db.execute(sql`
            DELETE FROM ${sql.raw(sideEffectLog)}
            WHERE effect_key IN (
              SELECT effect_key FROM ${sql.raw(sideEffectLog)}
              WHERE applied_at < ${cutoff}::timestamptz
              ORDER BY applied_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING effect_key
          `),
          ).length,
      ),
    );
  }

  // 5. Schedule ticks behind their schedule.
  if (has('flow_schedule_ticks')) {
    const guard = has('flow_schedules')
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM flow_schedules s
          WHERE s.id = t.schedule_id AND s.next_run_at IS NOT NULL AND s.next_run_at <= t.scheduled_for
        )`
      : sql``;
    result.scheduleTicks = note(
      await inBatches(
        resolved,
        async () =>
          asRows(
            await db.execute(sql`
            DELETE FROM flow_schedule_ticks
            WHERE id IN (
              SELECT t.id FROM flow_schedule_ticks t
              WHERE t.created_at < ${cutoff}::timestamptz
                ${guard}
              ORDER BY t.created_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id
          `),
          ).length,
      ),
    );
  }

  await pruneEventAndJobTables(db, resolved, result, note);
  return result;
}

/** Each class's table and the indexes its batches need. */
const CLASS_TABLES: Record<FrameworkRetentionClass, { table: string; indexes: string[] }> = {
  eventOutbox: { table: 'event_outbox', indexes: ['event_outbox_dispatched_idx'] },
  eventIdempotency: {
    table: 'event_idempotency',
    indexes: ['event_idempotency_processed_idx'],
  },
  eventDeadLetter: { table: 'event_dead_letter', indexes: ['event_dead_letter_resolved_idx'] },
  jobExecutions: { table: 'job_executions', indexes: ['job_exec_finished_idx'] },
};

/** A text-encoded UUID (the shape of an outbox row id); anything else cannot be one. */
const UUID_TEXT = sql.raw(
  `'^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'`,
);

/** The cutoff `keepDays` ago as ISO 8601 UTC text, the form `metadata.resolvedAt` is written in. */
async function isoCutoffOf(db: PostgresJsDatabase, keepDays: number): Promise<string> {
  const row = asRows(
    await db.execute(
      sql`SELECT to_char((now() - make_interval(secs => ${keepDays * 86_400}::double precision)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff`,
    ),
  )[0];
  return String(row?.cutoff);
}

/** The event and job classes that are on, on one database. */
async function pruneEventAndJobTables(
  db: PostgresJsDatabase,
  resolved: ResolvedFrameworkRetentionOptions,
  result: FrameworkRetentionResult,
  note: (outcome: { deleted: number; drained: boolean }) => number,
): Promise<void> {
  const limit = resolved.batchSize;
  const missing: string[] = [];
  const present = new Map<string, boolean>();
  const has = async (name: string): Promise<boolean> => {
    if (!present.has(name)) present.set(name, await tableExists(db, name));
    return present.get(name) === true;
  };
  /** Whether the class can run here: its table exists and so does every index it needs. */
  const ready = async (name: FrameworkRetentionClass): Promise<boolean> => {
    const { table, indexes } = CLASS_TABLES[name];
    if (!(await has(table))) return false;
    let ok = true;
    for (const index of indexes) {
      if (!(await has(index))) {
        missing.push(index);
        ok = false;
      }
    }
    return ok;
  };

  // 1. Dispatched outbox rows: before idempotency rows, which are kept while their event's
  //    outbox row exists.
  const outbox = resolved.eventOutbox;
  if (outbox) {
    result.eventOutbox = 0;
    if (await ready('eventOutbox')) {
      const cutoff = await cutoffOf(db, outbox.keepDays);
      result.eventOutbox = note(
        await inBatches(
          resolved,
          async () =>
            asRows(
              await db.execute(sql`
              DELETE FROM event_outbox
              WHERE id IN (
                SELECT id FROM event_outbox
                WHERE status = ${OUTBOX_DISPATCHED}
                  AND dispatched_at < ${cutoff}::timestamptz
                ORDER BY dispatched_at
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
              )
                AND status = ${OUTBOX_DISPATCHED}
              RETURNING id
            `),
            ).length,
        ),
      );
    }
  }

  // 2. Dead letters resolved long enough ago: before idempotency rows, which are kept while an
  //    unresolved dead letter of their event exists.
  const deadLetter = resolved.eventDeadLetter;
  if (deadLetter) {
    result.eventDeadLetters = 0;
    if (await ready('eventDeadLetter')) {
      const cutoff = await isoCutoffOf(db, deadLetter.keepDays);
      result.eventDeadLetters = note(
        await inBatches(
          resolved,
          async () =>
            asRows(
              await db.execute(sql`
              DELETE FROM event_dead_letter
              WHERE id IN (
                SELECT id FROM event_dead_letter
                WHERE ${DEAD_LETTER_RESOLVED} IS NOT NULL
                  AND ${DEAD_LETTER_RESOLVED} < ${cutoff}
                ORDER BY ${DEAD_LETTER_RESOLVED}
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
              )
                AND ${DEAD_LETTER_RESOLVED} IS NOT NULL
              RETURNING id
            `),
            ).length,
        ),
      );
    }
  }

  // 3. Idempotency rows of events this database can no longer deliver again.
  const idempotency = resolved.eventIdempotency;
  if (idempotency) {
    result.eventIdempotency = 0;
    const guards: SQL[] = [];
    let guarded = await ready('eventIdempotency');
    if (guarded && (await has('event_outbox'))) {
      guards.push(sql`AND NOT EXISTS (
        SELECT 1 FROM event_outbox o
        WHERE o.id = (CASE WHEN i.event_id ~ ${UUID_TEXT} THEN i.event_id::uuid END)
      )`);
    }
    if (guarded && (await has('event_dead_letter'))) {
      if (await has('event_dead_letter_unresolved_idx')) {
        guards.push(sql`AND NOT EXISTS (
          SELECT 1 FROM event_dead_letter d
          WHERE d.event_id = i.event_id AND ${sql.raw("(d.metadata->>'resolvedAt')")} IS NULL
        )`);
      } else {
        missing.push('event_dead_letter_unresolved_idx');
        guarded = false;
      }
    }
    if (guarded) {
      const cutoff = await cutoffOf(db, idempotency.keepDays);
      result.eventIdempotency = note(
        await inBatches(
          resolved,
          async () =>
            asRows(
              await db.execute(sql`
              DELETE FROM event_idempotency
              WHERE id IN (
                SELECT i.id FROM event_idempotency i
                WHERE i.processed_at < ${cutoff}::timestamptz
                  ${sql.join(guards, sql` `)}
                ORDER BY i.processed_at
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
              )
              RETURNING id
            `),
            ).length,
        ),
      );
    }
  }

  // 4. Finished jobs.
  const jobs = resolved.jobExecutions;
  if (jobs) {
    result.jobExecutions = 0;
    if (await ready('jobExecutions')) {
      const cutoff = await cutoffOf(db, jobs.keepDays);
      result.jobExecutions = note(
        await inBatches(
          resolved,
          async () =>
            asRows(
              await db.execute(sql`
              DELETE FROM job_executions
              WHERE id IN (
                SELECT id FROM job_executions
                WHERE status IN ${JOB_FINISHED}
                  AND completed_at < ${cutoff}::timestamptz
                  AND dispatch_pending = false
                ORDER BY completed_at
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
              )
                AND status IN ${JOB_FINISHED}
              RETURNING id
            `),
            ).length,
        ),
      );
    }
  }

  if (missing.length > 0) result.missingIndexes = [...new Set(missing)].sort();
}

/** Delete the acknowledged spine hints of executions whose tenant state was just pruned. */
async function deleteHintsOf(
  spineDb: PostgresJsDatabase,
  rows: Record<string, unknown>[],
): Promise<number> {
  const byRoute = new Map<string, string[]>();
  for (const row of rows) {
    const route = String(row.tenant_ref);
    const ids = byRoute.get(route) ?? [];
    ids.push(String(row.execution_id));
    byRoute.set(route, ids);
  }
  let deleted = 0;
  for (const [route, ids] of byRoute) {
    deleted += asRows(
      await spineDb.execute(sql`
        DELETE FROM opaque_dispatch
        WHERE tenant_route_id = ${route}
          AND execution_id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND delivery_state = ${SPINE_ACKNOWLEDGED}
        RETURNING dispatch_id
      `),
    ).length;
  }
  return deleted;
}

/**
 * Spine pass: acknowledged hints older than the cutoff that a later revision of the same
 * execution has replaced. The newest hint of each execution stays (see the file header).
 * A spine without `opaque_dispatch` returns zeros.
 */
export async function pruneSpineDispatchHints(
  spineDb: PostgresJsDatabase,
  options: FrameworkRetentionOptions = {},
): Promise<{ spineHints: number; drained: boolean }> {
  const resolved = resolveFrameworkRetentionOptions(options) as ResolvedFrameworkRetentionOptions;
  if (!(await tableExists(spineDb, 'opaque_dispatch'))) return { spineHints: 0, drained: true };
  const cutoff = await cutoffOf(spineDb, resolved.keepDays);
  const outcome = await inBatches(
    resolved,
    async () =>
      asRows(
        await spineDb.execute(sql`
        DELETE FROM opaque_dispatch
        WHERE dispatch_id IN (
          SELECT d.dispatch_id FROM opaque_dispatch d
          WHERE d.delivery_state = ${SPINE_ACKNOWLEDGED}
            AND d.created_at < ${cutoff}::timestamptz
            AND EXISTS (
              SELECT 1 FROM opaque_dispatch n
              WHERE n.tenant_route_id = d.tenant_route_id
                AND n.execution_id = d.execution_id
                AND n.expected_revision > d.expected_revision
            )
          ORDER BY d.created_at
          LIMIT ${resolved.batchSize}
          FOR UPDATE SKIP LOCKED
        )
          AND delivery_state = ${SPINE_ACKNOWLEDGED}
        RETURNING dispatch_id
      `),
      ).length,
  );
  return { spineHints: outcome.deleted, drained: outcome.drained };
}
