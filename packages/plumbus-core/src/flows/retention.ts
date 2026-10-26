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
//   • audit records, event tables and job executions (app policy; not touched).

import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { DurableExecutionStatus, qualifyTable, SpineDeliveryState } from '../durable/index.js';
import { DataValidationError } from '../errors/index.js';
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
}

export type ResolvedFrameworkRetentionOptions = Required<FrameworkRetentionOptions>;

const retentionOptionsSchema = z
  .object({
    keepDays: z.number().finite().min(1).optional(),
    batchSize: z.number().int().min(1).max(10_000).optional(),
    maxBatchesPerTable: z.number().int().min(1).max(10_000).optional(),
    intervalMs: z.number().int().min(1).optional(),
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
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  return Object.freeze({ ...FRAMEWORK_RETENTION_DEFAULTS, ...parsed.data });
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

  return result;
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
