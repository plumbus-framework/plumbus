import { databaseTime } from './database-clock.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DataValidationError } from '../errors/index.js';
import type { LoggerService } from '../types/context.js';
import type { FlowDefinition } from '../types/flow.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';
import { flowExecutionsTable, flowSchedulesTable, flowScheduleTicksTable } from './schema.js';
import { createFlowExecutionRecord } from './execution-record.js';
import { computeNextRun, validateSchedule } from './cron.js';
export { computeNextRun } from './cron.js';

export interface SchedulerConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  engine: ReturnType<typeof createFlowEngine>;
  logger?: LoggerService;
  pollIntervalMs?: number;
}
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
function definitionHash(flow: FlowDefinition) {
  return hash({ name: flow.name, schedule: scheduleDefinition(flow), steps: flow.steps });
}

export function createFlowScheduler(config: SchedulerConfig) {
  const { db, registry, engine, logger = console, pollIntervalMs = 60000 } = config;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<number> | undefined;
  let lastWarning = -Infinity;
  function warn(flowName: string, reason: string) {
    if (Date.now() - lastWarning < 60000) return;
    lastWarning = Date.now();
    logger.warn('Schedule requires reconciliation', { flowName, reason });
  }
  async function syncSchedules(): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('plumbus:schedule-reconciliation'))`,
      );
      const existing = await tx.select().from(flowSchedulesTable);
      const scheduled = registry.getScheduled();
      const now = await databaseTime(tx);
      let count = 0;
      for (const flow of scheduled) {
        const definition = scheduleDefinition(flow);
        if (existing.length > 0) {
          if (
            !existing.some(
              (row) =>
                row.flowName === flow.name &&
                row.definitionHash === definitionHash(flow) &&
                !row.removed,
            )
          )
            warn(flow.name, 'deployment_sync_required');
          continue;
        }
        const inserted = await tx
          .insert(flowSchedulesTable)
          .values({
            flowName: flow.name,
            ...definition,
            definitionHash: definitionHash(flow),
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
  /** One deployment applies a complete manifest. Stale applications cannot overwrite it. */
  async function reconcileSchedules(options: { apply?: boolean; expectedRevision?: string } = {}) {
    return db.transaction(async (tx) => {
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
      const desired = registry.getScheduled();
      const changes: { flowName: string; action: string; previous?: unknown; next?: unknown }[] =
        [];
      const now = await databaseTime(tx);
      for (const flow of desired) {
        const definition = scheduleDefinition(flow);
        const fingerprint = definitionHash(flow);
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
          if (row.nextRunAt && row.nextRunAt <= now)
            await tx
              .insert(flowScheduleTicksTable)
              .values({
                scheduleId: row.id,
                scheduledFor: row.nextRunAt,
                revision: row.revision,
                outcome: 'skipped_configuration_change',
              })
              .onConflictDoNothing();
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
        });
        if (options.apply)
          await tx
            .update(flowSchedulesTable)
            .set({ removed: true, revision: row.revision + 1 })
            .where(eq(flowSchedulesTable.id, row.id));
      }
      return { revision, changes, applied: options.apply === true };
    });
  }
  async function runPoll(): Promise<number> {
    const wakes = await db.transaction(async (tx) => {
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
      const created: string[] = [];
      for (const row of due) {
        const flow = registry.get(row.flowName);
        if (!flow?.schedule) {
          warn(row.flowName, 'missing_local_definition');
          continue;
        }
        if (definitionHash(flow) !== row.definitionHash) {
          warn(row.flowName, 'definition_drift');
          continue;
        }
        if (!row.nextRunAt) continue;
        const nextRunAt = computeNextRun(row.cron, now, row.timezone ?? undefined);
        const running =
          row.overlap === 'skip'
            ? await tx
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
                      ),
                    ),
                    inArray(flowExecutionsTable.status, ['created', 'running', 'waiting']),
                  ),
                )
                .limit(1)
            : [];
        const tickId = randomUUID();
        const executionId = randomUUID();
        const tick = await tx
          .insert(flowScheduleTicksTable)
          .values({
            id: tickId,
            scheduleId: row.id,
            scheduledFor: row.nextRunAt,
            revision: row.revision,
            executionId: running.length ? null : executionId,
            outcome: running.length ? 'skipped_overlap' : 'started',
          })
          .onConflictDoNothing()
          .returning({ id: flowScheduleTicksTable.id });
        if (tick.length && !running.length) {
          await createFlowExecutionRecord(
            tx as unknown as PostgresJsDatabase,
            flow,
            {},
            { userId: 'system-scheduler', roles: ['system'], scopes: [], provider: 'scheduler' },
            { executionId, scheduleId: row.id, scheduleTickId: tickId },
          );
          created.push(executionId);
        }
        await tx
          .update(flowSchedulesTable)
          .set({ lastRunAt: now, nextRunAt })
          .where(eq(flowSchedulesTable.id, row.id));
      }
      return created;
    });
    for (const id of wakes) {
      try {
        await engine.wake(id);
      } catch {
        logger.error('Scheduled execution persisted; wake awaits database reconciliation', {
          executionId: id,
        });
      }
    }
    return wakes.length;
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
