import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DataValidationError } from '../errors/index.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { LoggerService } from '../types/context.js';
import { type FlowDefinition, ScheduleCatchUpPolicy } from '../types/flow.js';
import type { AuthContext } from '../types/security.js';
import { computeNextRun, validateSchedule } from './cron.js';
import { databaseTime } from './database-clock.js';
import type { PendingFlowExecution, createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';
import { flowExecutionsTable, flowSchedulesTable, flowScheduleTicksTable } from './schema.js';
export { computeNextRun } from './cron.js';

/** Bound on catch-up starts per poll so a missed window cannot flood the engine. */
export const DEFAULT_SCHEDULE_CATCH_UP_MAX = 3;

export interface MissedSchedulePlan {
  /** How many executions the due schedule starts now (one per entry of `slots`). */
  starts: number;
  /** The scheduled times the starts stand for; each becomes one durable tick. */
  slots: Date[];
  /** Where `nextRunAt` is parked: always after `now`. */
  nextRunAt: Date;
}

/**
 * Decide which missed slots of a due schedule to start and where to park `nextRunAt`.
 * `nextRunAt` is the stored `flow_schedules.next_run_at` (the first missed slot).
 *
 * `skip` (default) and `run-once` start one execution for the overdue work; `catch-up` starts
 * one per missed slot, at most `maxCatchUp`. Slots are stepped from `nextRunAt`; when the
 * missed window is longer than that, the next run jumps straight to the first occurrence
 * after `now` instead of stepping through the backlog.
 */
export function planMissedSchedule(input: {
  cron: string;
  nextRunAt: Date;
  now: Date;
  policy?: string;
  maxCatchUp?: number;
  timezone?: string;
}): MissedSchedulePlan {
  const take =
    input.policy === ScheduleCatchUpPolicy.CatchUp
      ? Math.max(1, input.maxCatchUp ?? DEFAULT_SCHEDULE_CATCH_UP_MAX)
      : 1;
  const slots: Date[] = [];
  let cursor = input.nextRunAt;
  while (cursor.getTime() <= input.now.getTime() && slots.length < take) {
    slots.push(cursor);
    cursor = computeNextRun(input.cron, cursor, input.timezone);
  }
  const nextRunAt =
    cursor.getTime() > input.now.getTime()
      ? cursor
      : computeNextRun(input.cron, input.now, input.timezone);
  return { starts: slots.length, slots, nextRunAt };
}

export interface SchedulerConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  engine: ReturnType<typeof createFlowEngine>;
  /** Optional logger for error reporting (default: console). */
  logger?: LoggerService;
  /** Poll interval in milliseconds (default: 60000 = 1 min) */
  pollIntervalMs?: number;
  /**
   * When set with `listTenantRefs`, sync, reconciliation and polling run against each tenant's
   * `flow_schedules` (not the pool `db`) for flows scheduled on `tenants`. Started flows carry
   * that tenant on auth. Flows scheduled on `spine` keep their row on the pool `db`.
   */
  resolver?: DataPlaneResolver;
  listTenantRefs?: () => Iterable<string> | Promise<Iterable<string>>;
  /** Max starts per due row when `catchUpPolicy` is `catch-up`. Default 3. */
  maxCatchUp?: number;
  /**
   * Where executions (and their ticks) of TENANT-plane schedules are created: `'schedule-plane'`
   * (the engine places tenant flows on their plane, which needs its spine dispatch) or `'pool'`
   * (schedule planes only; flows keep the pool plane, so the tick and the execution commit
   * together on the pool, where the engine claims them). Default: `'schedule-plane'` when the
   * engine has spine dispatch, `'pool'` otherwise. Polling refuses `'schedule-plane'` with an
   * engine without spine dispatch (it would create executions no engine claims); reconciliation
   * accepts it, so `plumbus flow schedule sync` can name the worker's planes with a plain engine.
   */
  tenantExecutions?: 'schedule-plane' | 'pool';
}

/** Changes a reconciliation reports; `tenantRef` names the tenant plane a change belongs to. */
export interface ScheduleChange {
  flowName: string;
  action: 'create' | 'update' | 'remove';
  previous?: unknown;
  next?: unknown;
  tenantRef?: string;
}

export interface ScheduleReconciliation {
  revision: string;
  changes: ScheduleChange[];
  applied: boolean;
}

interface SchedulePlane {
  db: PostgresJsDatabase;
  tenantRef?: string;
}

type ScheduleTick = typeof flowScheduleTicksTable.$inferInsert;

function scheduleDefinition(flow: FlowDefinition) {
  const schedule = flow.schedule;
  if (!schedule) throw new DataValidationError('Flow has no schedule', { flowName: flow.name });
  validateSchedule(schedule, flow.name);
  return {
    cron: schedule.cron,
    timezone: schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    overlap: schedule.overlap ?? 'allow',
    firstRun: schedule.firstRun ?? 'immediate',
  };
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The persisted schedule fingerprint (`flow_schedules.definition_hash`). `catchUpPolicy` and
 * `plane` take part only when set, so a schedule that does not use them keeps the fingerprint
 * the 0.8 stable family stored for it.
 */
export function scheduleFingerprint(flow: FlowDefinition): string {
  const schedule = flow.schedule;
  return hash({
    name: flow.name,
    schedule: {
      ...scheduleDefinition(flow),
      ...(schedule?.catchUpPolicy ? { catchUpPolicy: schedule.catchUpPolicy } : {}),
      ...(schedule?.plane ? { plane: schedule.plane } : {}),
    },
    steps: flow.steps,
  });
}

/** The error and, when a driver wrapped it, the cause underneath — the part that names the table. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} — ${cause.message}` : err.message;
}

/**
 * Durable flow scheduler. Each poll locks the due `flow_schedules` rows, records one unique tick
 * per started slot, creates the execution through the engine and advances the schedule in one
 * transaction; queue wake-ups happen after commit and database polling recovers a lost one.
 *
 * With `resolver` + `listTenantRefs` every schedule plane (the pool for `spine` flows, each
 * resolved tenant plane for `tenants` flows) is synced, reconciled and polled on its own
 * database. A failing tenant plane is logged and skipped; a failing schedule is rolled back to
 * its savepoint and logged, so it never blocks the other schedules due with it.
 */
export function createFlowScheduler(config: SchedulerConfig) {
  const {
    db,
    registry,
    engine,
    logger = console,
    pollIntervalMs = 60000,
    resolver,
    listTenantRefs,
  } = config;
  const maxCatchUp = config.maxCatchUp ?? DEFAULT_SCHEDULE_CATCH_UP_MAX;
  // A tenant-plane execution is claimable only through the spine hint an engine with spine
  // dispatch publishes; a plain engine claims from its own `db`, so its runs start on the pool.
  const placesTenantExecutions = engine.placesTenantExecutions === true;
  const tenantExecutions =
    config.tenantExecutions ?? (placesTenantExecutions ? 'schedule-plane' : 'pool');
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<number> | undefined;
  let lastWarning = -Infinity;

  const systemAuth: AuthContext = {
    userId: 'system-scheduler',
    roles: ['system'],
    scopes: [],
    provider: 'scheduler',
  };

  function warn(flowName: string, reason: string, tenantRef?: string) {
    if (Date.now() - lastWarning < 60000) return;
    lastWarning = Date.now();
    logger.warn('Schedule requires reconciliation', {
      flowName,
      reason,
      ...(tenantRef ? { tenantRef } : {}),
    });
  }

  const multiPlane = Boolean(resolver && listTenantRefs);
  /** Which plane a scheduled flow belongs to; without tenant planes everything is the pool's. */
  function planeOf(flow: FlowDefinition | undefined): 'spine' | 'tenants' {
    if (!multiPlane) return 'spine';
    return flow?.schedule?.plane ?? 'tenants';
  }
  function planeKind(plane: SchedulePlane): 'spine' | 'tenants' {
    return plane.tenantRef === undefined ? 'spine' : 'tenants';
  }
  function desiredOn(plane: SchedulePlane): FlowDefinition[] {
    return registry.getScheduled().filter((flow) => planeOf(flow) === planeKind(plane));
  }
  /** Ticks and executions of a tenant-plane schedule live on the pool under `tenantExecutions: 'pool'`. */
  function ticksOnPool(plane: SchedulePlane): boolean {
    return plane.tenantRef !== undefined && tenantExecutions === 'pool';
  }

  /**
   * The planes to sync, reconcile and poll: the pool database when a registered flow is
   * scheduled on the spine, plus every resolved tenant plane when the pool has schedule planes.
   * The pool is skipped entirely when nothing is scheduled there, so a tenant-only host never
   * reads it. A tenant plane that cannot be resolved is skipped with a warning, unless `strict`
   * (reconciliation must cover every plane or fail).
   */
  async function tenantPlanes(strict = false): Promise<SchedulePlane[]> {
    if (!resolver || !listTenantRefs) {
      return [{ db }];
    }
    const planes: SchedulePlane[] = [];
    if (registry.getScheduled().some((flow) => planeOf(flow) === 'spine')) {
      planes.push({ db });
    }
    const refs = [...(await listTenantRefs())];
    for (const tenantRef of refs) {
      try {
        const handle = await resolver.resolve(tenantRef);
        planes.push({ db: handle.db, tenantRef: handle.tenantRef });
      } catch (err: unknown) {
        if (strict) throw err;
        logger.warn('Scheduler skipped a tenant plane it could not resolve', {
          tenantRef,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return planes;
  }

  async function syncPlane(plane: SchedulePlane): Promise<number> {
    const scheduled = desiredOn(plane);
    return plane.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('plumbus:schedule-reconciliation'))`,
      );
      const existing = await tx.select().from(flowSchedulesTable);
      const now = await databaseTime(tx);
      let count = 0;
      for (const flow of scheduled) {
        const definition = scheduleDefinition(flow);
        const fingerprint = scheduleFingerprint(flow);
        if (existing.length > 0) {
          if (
            !existing.some(
              (row) =>
                row.flowName === flow.name && row.definitionHash === fingerprint && !row.removed,
            )
          )
            warn(flow.name, 'deployment_sync_required', plane.tenantRef);
          continue;
        }
        const inserted = await tx
          .insert(flowSchedulesTable)
          .values({
            flowName: flow.name,
            ...definition,
            definitionHash: fingerprint,
            revision: 1,
            nextRunAt:
              definition.firstRun === 'immediate'
                ? now
                : computeNextRun(definition.cron, now, definition.timezone),
          })
          .onConflictDoNothing({ target: flowSchedulesTable.flowName })
          .returning({ id: flowSchedulesTable.id });
        count += inserted.length;
      }
      return count;
    });
  }

  /**
   * Seed the initial schedule set. A plane whose table is empty gets every flow scheduled on
   * it; an established plane is never added to or overwritten (that needs reconciliation).
   * A plane whose schedule table is missing or behind must not stop the others, nor boot.
   */
  async function syncSchedules(): Promise<number> {
    let synced = 0;
    for (const plane of await tenantPlanes()) {
      try {
        synced += await syncPlane(plane);
      } catch (err: unknown) {
        logger.error('Scheduler could not sync schedules on a plane', {
          tenantRef: plane.tenantRef,
          error: describeError(err),
        });
      }
    }
    return synced;
  }

  /** Main's revision-checked reconciliation, on one plane's database. */
  async function reconcilePlane(
    plane: SchedulePlane,
    options: { apply: boolean; expectedRevision?: string },
  ): Promise<{ revision: string; changes: ScheduleChange[] }> {
    const desired = desiredOn(plane);
    const tenantChange = plane.tenantRef === undefined ? {} : { tenantRef: plane.tenantRef };
    // Superseded ticks of a pool-ticked tenant plane are recorded once its plane commits.
    const supersededOnPool: ScheduleTick[] = [];
    const result = await plane.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('plumbus:schedule-reconciliation'))`,
      );
      const stored = await tx.select().from(flowSchedulesTable).for('update');
      const revision = hash(
        stored
          .sort((a, b) => a.flowName.localeCompare(b.flowName))
          .map((row) => [
            row.id,
            row.revision,
            row.definitionHash,
            row.cron,
            row.enabled,
            row.removed,
          ]),
      );
      if (options.apply && options.expectedRevision !== revision)
        throw new DataValidationError('Schedule revision changed; preview reconciliation again', {
          revision,
        });
      const changes: ScheduleChange[] = [];
      const now = await databaseTime(tx);
      for (const flow of desired) {
        const definition = scheduleDefinition(flow);
        const fingerprint = scheduleFingerprint(flow);
        const row = stored.find((item) => item.flowName === flow.name);
        if (row && row.definitionHash === fingerprint && !row.removed) continue;
        changes.push({
          flowName: flow.name,
          action: row ? 'update' : 'create',
          previous: row
            ? {
                cron: row.cron,
                timezone: row.timezone,
                overlap: row.overlap,
                enabled: row.enabled,
                removed: row.removed,
                nextRunAt: row.nextRunAt,
              }
            : undefined,
          next: definition,
          ...tenantChange,
        });
        if (!options.apply) continue;
        if (!row) {
          await tx.insert(flowSchedulesTable).values({
            flowName: flow.name,
            ...definition,
            definitionHash: fingerprint,
            revision: 1,
            nextRunAt:
              definition.firstRun === 'immediate'
                ? now
                : computeNextRun(definition.cron, now, definition.timezone),
          });
        } else {
          // The explicit deployment change supersedes any unmaterialized overdue tick.
          if (row.nextRunAt && row.nextRunAt <= now) {
            const superseded: ScheduleTick = {
              scheduleId: row.id,
              scheduledFor: row.nextRunAt,
              revision: row.revision,
              outcome: 'skipped_configuration_change',
            };
            if (ticksOnPool(plane)) supersededOnPool.push(superseded);
            else await tx.insert(flowScheduleTicksTable).values(superseded).onConflictDoNothing();
          }
          await tx
            .update(flowSchedulesTable)
            .set({
              ...definition,
              definitionHash: fingerprint,
              revision: row.revision + 1,
              removed: false,
              adoptedAt: row.definitionHash ? row.adoptedAt : now,
              nextRunAt: computeNextRun(definition.cron, now, definition.timezone),
            })
            .where(eq(flowSchedulesTable.id, row.id));
        }
      }
      for (const row of stored) {
        if (row.removed || desired.some((flow) => flow.name === row.flowName)) continue;
        changes.push({
          flowName: row.flowName,
          action: 'remove',
          previous: { cron: row.cron, enabled: row.enabled, nextRunAt: row.nextRunAt },
          ...tenantChange,
        });
        if (options.apply)
          await tx
            .update(flowSchedulesTable)
            .set({ removed: true, revision: row.revision + 1 })
            .where(eq(flowSchedulesTable.id, row.id));
      }
      return { revision, changes };
    });
    if (supersededOnPool.length > 0)
      await db.insert(flowScheduleTicksTable).values(supersededOnPool).onConflictDoNothing();
    return result;
  }

  /**
   * One deployment applies a complete manifest. Stale applications cannot overwrite it.
   *
   * With schedule planes the revision covers every plane (the pool when it holds spine
   * schedules, each tenant plane) and the changes name their `tenantRef`. Applying re-checks
   * the combined revision, then applies plane by plane, each under its own lock and revision
   * check: the apply is atomic per plane, not across planes — after a partial failure, preview
   * again and re-apply; reconciliation converges.
   */
  async function reconcileSchedules(
    options: { apply?: boolean; expectedRevision?: string } = {},
  ): Promise<ScheduleReconciliation> {
    const apply = options.apply === true;
    if (!multiPlane) {
      const { revision, changes } = await reconcilePlane(
        { db },
        { apply, expectedRevision: options.expectedRevision },
      );
      return { revision, changes, applied: apply };
    }
    const planes = await tenantPlanes(true);
    const previews: Array<{ plane: SchedulePlane; revision: string; changes: ScheduleChange[] }> =
      [];
    for (const plane of planes) {
      previews.push({ plane, ...(await reconcilePlane(plane, { apply: false })) });
    }
    const revision = hash(
      previews
        .map((preview): [string, string] => [preview.plane.tenantRef ?? '', preview.revision])
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
    if (!apply) {
      return { revision, changes: previews.flatMap((preview) => preview.changes), applied: false };
    }
    if (options.expectedRevision !== revision)
      throw new DataValidationError('Schedule revision changed; preview reconciliation again', {
        revision,
      });
    const changes: ScheduleChange[] = [];
    for (const preview of previews) {
      const applied = await reconcilePlane(preview.plane, {
        apply: true,
        expectedRevision: preview.revision,
      });
      changes.push(...applied.changes);
    }
    return { revision, changes, applied: true };
  }

  /**
   * Poll one plane: lock its due schedules, then per schedule (in a savepoint) record a tick per
   * slot, create the executions through the engine and advance the schedule. Executions are
   * announced and woken only once the transaction that holds them committed.
   */
  async function pollPlane(plane: SchedulePlane): Promise<{ created: number; error?: unknown }> {
    const executionStore = ticksOnPool(plane) ? db : plane.db;
    const auth: AuthContext = plane.tenantRef
      ? { ...systemAuth, tenantId: plane.tenantRef }
      : systemAuth;
    const inTransaction: PendingFlowExecution[] = [];
    const committedElsewhere: PendingFlowExecution[] = [];
    let failure: { error: unknown } | undefined;
    try {
      await plane.db.transaction(async (tx) => {
        const now = await databaseTime(tx);
        const due = await tx
          .select()
          .from(flowSchedulesTable)
          .where(
            and(
              eq(flowSchedulesTable.enabled, true),
              eq(flowSchedulesTable.removed, false),
              lte(flowSchedulesTable.nextRunAt, now),
            ),
          )
          .limit(50)
          .for('update', { skipLocked: true });
        for (const row of due) {
          const dueAt = row.nextRunAt;
          if (!row.enabled || row.removed || !dueAt || dueAt > now) continue;
          const flow = registry.get(row.flowName);
          if (!flow?.schedule) {
            warn(row.flowName, 'missing_local_definition', plane.tenantRef);
            continue;
          }
          // A row left on the wrong plane (a flow moved between spine and tenants) is not started.
          if (planeOf(flow) !== planeKind(plane)) continue;
          const created: PendingFlowExecution[] = [];
          try {
            if (scheduleFingerprint(flow) !== row.definitionHash) {
              warn(row.flowName, 'definition_drift', plane.tenantRef);
              continue;
            }
            const plan = planMissedSchedule({
              cron: row.cron,
              nextRunAt: dueAt,
              now,
              policy: flow.schedule.catchUpPolicy,
              maxCatchUp,
              timezone: row.timezone ?? undefined,
            });
            const materialize = async (store: PostgresJsDatabase) => {
              for (const slot of plan.slots) {
                const running =
                  row.overlap === 'skip'
                    ? await store
                        .select({ id: flowExecutionsTable.id })
                        .from(flowExecutionsTable)
                        .where(
                          and(
                            or(
                              eq(flowExecutionsTable.scheduleId, row.id),
                              and(
                                isNull(flowExecutionsTable.scheduleId),
                                eq(flowExecutionsTable.flowName, row.flowName),
                                lt(flowExecutionsTable.createdAt, row.adoptedAt),
                                plane.tenantRef
                                  ? eq(flowExecutionsTable.tenantId, plane.tenantRef)
                                  : undefined,
                              ),
                            ),
                            inArray(flowExecutionsTable.status, ['created', 'running', 'waiting']),
                          ),
                        )
                        .limit(1)
                    : [];
                const tickId = randomUUID();
                const executionId = randomUUID();
                const tick = await store
                  .insert(flowScheduleTicksTable)
                  .values({
                    id: tickId,
                    scheduleId: row.id,
                    scheduledFor: slot,
                    revision: row.revision,
                    executionId: running.length ? null : executionId,
                    outcome: running.length ? 'skipped_overlap' : 'started',
                  })
                  .onConflictDoNothing()
                  .returning({ id: flowScheduleTicksTable.id });
                if (tick.length && !running.length) {
                  created.push(
                    await engine.createExecution(store, flow.name, {}, auth, {
                      executionId,
                      scheduleId: row.id,
                      scheduleTickId: tickId,
                    }),
                  );
                }
              }
            };
            // Savepoint: a failing schedule rolls back its own ticks and executions only.
            await tx.transaction(async (savepoint) => {
              if (ticksOnPool(plane)) {
                // The tick and the execution commit together on the pool. Should the plane fail
                // afterwards, the schedule stays due and the next poll's tick insert conflicts on
                // (schedule_id, scheduled_for): it only advances `nextRunAt`.
                await db.transaction(async (poolTx) =>
                  materialize(poolTx as unknown as PostgresJsDatabase),
                );
                committedElsewhere.push(...created.splice(0));
              } else {
                await materialize(savepoint as unknown as PostgresJsDatabase);
              }
              await savepoint
                .update(flowSchedulesTable)
                .set({ lastRunAt: now, nextRunAt: plan.nextRunAt })
                .where(eq(flowSchedulesTable.id, row.id));
            });
            inTransaction.push(...created);
          } catch (err: unknown) {
            logger.error(`Scheduler failed to start flow "${row.flowName}"`, {
              flowName: row.flowName,
              scheduleId: row.id,
              tenantRef: plane.tenantRef,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });
    } catch (error: unknown) {
      failure = { error };
    }
    const committed = failure ? committedElsewhere : [...committedElsewhere, ...inTransaction];
    for (const pending of committed) {
      try {
        await engine.announceExecution(pending, { store: executionStore, auth });
      } catch (err: unknown) {
        logger.error('Scheduled execution persisted; start announcement failed', {
          executionId: pending.id,
          flowName: pending.flowName,
          tenantRef: plane.tenantRef,
          error: describeError(err),
        });
      }
      try {
        await engine.wake(pending.id);
      } catch {
        logger.error('Scheduled execution persisted; wake awaits database reconciliation', {
          executionId: pending.id,
        });
      }
    }
    return failure
      ? { created: committed.length, error: failure.error }
      : { created: committed.length };
  }

  async function runPoll(): Promise<number> {
    // An explicit 'schedule-plane' with an engine without spine dispatch would create tenant
    // executions no engine claims. Reconciliation (the CLI) never polls, so only polling refuses.
    if (
      multiPlane &&
      tenantExecutions === 'schedule-plane' &&
      !placesTenantExecutions &&
      registry.getScheduled().some((flow) => planeOf(flow) === 'tenants')
    )
      throw new DataValidationError(
        "Scheduler tenantExecutions 'schedule-plane' needs a flow engine with spineDispatch; without it tenant-plane executions are never claimed (use 'pool')",
      );
    let created = 0;
    let poolFailure: { error: unknown } | undefined;
    for (const plane of await tenantPlanes()) {
      const result = await pollPlane(plane);
      created += result.created;
      if (!('error' in result)) continue;
      if (plane.tenantRef === undefined) {
        // The pool's failure rejects the poll once the other planes ran (the timer logs it).
        poolFailure = { error: result.error };
        continue;
      }
      logger.error('Scheduler could not read schedules on a plane', {
        tenantRef: plane.tenantRef,
        error: describeError(result.error),
      });
    }
    if (poolFailure) throw poolFailure.error;
    return created;
  }
  function poll(): Promise<number> {
    active ??= runPoll().finally(() => {
      active = undefined;
    });
    return active;
  }
  return {
    syncSchedules,
    reconcileSchedules,
    poll,
    start() {
      timer ??= setInterval(() => {
        void poll().catch((err: unknown) =>
          logger.error('Scheduler poll failed; durable ticks remain recoverable', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }, pollIntervalMs);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await active?.catch(() => {});
    },
    get isRunning() {
      return timer !== undefined;
    },
  };
}
