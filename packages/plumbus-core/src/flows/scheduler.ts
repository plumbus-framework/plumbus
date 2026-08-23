import { createRequire } from 'node:module';
import { eq, lte } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { LoggerService } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import { ScheduleCatchUpPolicy } from '../types/flow.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';
import { flowSchedulesTable } from './schema.js';

/** Bound on catch-up starts per poll so a missed window cannot flood the engine. */
export const DEFAULT_SCHEDULE_CATCH_UP_MAX = 3;

export interface MissedSchedulePlan {
  starts: number;
  nextRunAt: Date;
}

function toDate(value: Date | string | null | undefined, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

/**
 * Decide how many times to start a due schedule and where to park `nextRunAt`.
 * `wakeAt` is `nextRunAt` on the existing `flow_schedules` row.
 */
export function planMissedSchedule(input: {
  cron: string;
  nextRunAt: Date;
  now: Date;
  policy?: string;
  maxCatchUp?: number;
}): MissedSchedulePlan {
  const maxCatchUp = Math.max(1, input.maxCatchUp ?? DEFAULT_SCHEDULE_CATCH_UP_MAX);
  const policy = input.policy ?? ScheduleCatchUpPolicy.Skip;
  const take = policy === ScheduleCatchUpPolicy.CatchUp ? maxCatchUp : 1;

  let cursor = input.nextRunAt;
  let starts = 0;
  while (cursor.getTime() <= input.now.getTime() && starts < take) {
    starts += 1;
    cursor = computeNextRun(input.cron, cursor);
  }
  while (cursor.getTime() <= input.now.getTime()) {
    cursor = computeNextRun(input.cron, cursor);
  }
  return { starts: Math.max(starts, 0), nextRunAt: cursor };
}

export interface SchedulerConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  engine: ReturnType<typeof createFlowEngine>;
  /** Optional logger for error reporting */
  logger?: LoggerService;
  /** Poll interval in milliseconds (default: 60000 = 1 min) */
  pollIntervalMs?: number;
  /**
   * When set with `listTenantRefs`, sync and poll run against each tenant's
   * `flow_schedules` (not the pool `db`). Started flows carry that tenant on auth.
   */
  resolver?: DataPlaneResolver;
  listTenantRefs?: () => Iterable<string> | Promise<Iterable<string>>;
  /** Max starts per due row when `catchUpPolicy` is `catch-up`. Default 3. */
  maxCatchUp?: number;
}

/**
 * Simple cron-like scheduler that polls for flows whose nextRunAt has passed.
 * Uses the flow_schedules table to track run state.
 *
 * Note: This is a simplified implementation. For production use, consider
 * a proper cron parser library (e.g., cron-parser) for nextRunAt computation.
 */
export function createFlowScheduler(config: SchedulerConfig) {
  const {
    db,
    registry,
    engine,
    logger,
    pollIntervalMs = 60_000,
    resolver,
    listTenantRefs,
  } = config;
  const maxCatchUp = config.maxCatchUp ?? DEFAULT_SCHEDULE_CATCH_UP_MAX;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const systemAuth: AuthContext = {
    userId: 'system-scheduler',
    roles: ['system'],
    scopes: [],
    provider: 'scheduler',
  };

  async function tenantPlanes(): Promise<Array<{ db: PostgresJsDatabase; tenantRef?: string }>> {
    if (!resolver || !listTenantRefs) {
      return [{ db }];
    }
    const refs = [...(await listTenantRefs())];
    const planes: Array<{ db: PostgresJsDatabase; tenantRef?: string }> = [];
    for (const tenantRef of refs) {
      const handle = await resolver.resolve(tenantRef);
      planes.push({ db: handle.db, tenantRef: handle.tenantRef });
    }
    return planes;
  }

  /**
   * Sync registered flows with schedules into the database.
   * Call once at startup to ensure all scheduled flows have a row.
   */
  async function syncSchedules(): Promise<number> {
    const scheduled = registry.getScheduled();
    let synced = 0;
    const planes = await tenantPlanes();

    for (const plane of planes) {
      for (const flow of scheduled) {
        if (!flow.schedule?.cron) continue;

        const existing = await plane.db
          .select()
          .from(flowSchedulesTable)
          .where(eq(flowSchedulesTable.flowName, flow.name))
          .limit(1);

        if (existing.length === 0) {
          await plane.db.insert(flowSchedulesTable).values({
            flowName: flow.name,
            cron: flow.schedule.cron,
            nextRunAt: new Date(), // first run immediately
          });
          synced++;
        }
      }
    }

    return synced;
  }

  /**
   * Run a single poll cycle: find due schedules and start flows.
   */
  async function poll(): Promise<number> {
    const now = new Date();
    let triggered = 0;
    const planes = await tenantPlanes();

    for (const plane of planes) {
      const dueSchedules = await plane.db
        .select()
        .from(flowSchedulesTable)
        .where(lte(flowSchedulesTable.nextRunAt, now));

      for (const schedule of dueSchedules) {
        if (!schedule.enabled) continue;

        try {
          const auth: AuthContext = plane.tenantRef
            ? { ...systemAuth, tenantId: plane.tenantRef }
            : systemAuth;
          const flow = registry.get(schedule.flowName);
          const dueAt = toDate(schedule.nextRunAt, now);
          const plan = planMissedSchedule({
            cron: schedule.cron,
            nextRunAt: dueAt,
            now,
            policy: flow?.schedule?.catchUpPolicy,
            maxCatchUp,
          });
          for (let i = 0; i < plan.starts; i++) {
            await engine.start(schedule.flowName, {}, auth);
            triggered++;
          }
          await plane.db
            .update(flowSchedulesTable)
            .set({
              lastRunAt: now,
              nextRunAt: plan.nextRunAt,
            })
            .where(eq(flowSchedulesTable.id, schedule.id));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.error(`Scheduler failed to start flow "${schedule.flowName}"`, {
            flowName: schedule.flowName,
            scheduleId: schedule.id,
            tenantRef: plane.tenantRef,
            error: message,
          });
        }
      }
    }

    return triggered;
  }

  return {
    syncSchedules,
    poll,

    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        void poll();
      }, pollIntervalMs);
    },

    stop(): void {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    get isRunning(): boolean {
      return running;
    },
  };
}

/**
 * Compute the next run time from a cron expression or interval pattern.
 *
 * Supports:
 * - Simple intervals: "every:60m", "every:24h", "every:1d"
 * - Standard 5-field cron: "minute hour day-of-month month day-of-week"
 *
 * Cron fields: minute (0-59), hour (0-23), day-of-month (1-31),
 * month (1-12), day-of-week (0-6, 0=Sunday).
 * Supports wildcards, specific values, ranges (1-5), step values,
 * comma-separated lists, and day/month name abbreviations.
 */
const localRequire = createRequire(import.meta.url);

function tryCronParserNext(cron: string, from: Date): Date | undefined {
  try {
    const cronParser = localRequire('cron-parser') as {
      parseExpression: (
        expression: string,
        options?: { currentDate?: Date },
      ) => { next: () => { toDate: () => Date } };
    };
    return cronParser.parseExpression(cron, { currentDate: from }).next().toDate();
  } catch {
    return undefined;
  }
}

export function computeNextRun(cron: string, from: Date): Date {
  const parsed = tryCronParserNext(cron, from);
  if (parsed) {
    return parsed;
  }

  // Parse simple interval patterns like "every:60m", "every:24h", "every:1d"
  const match = cron.match(/^every:(\d+)([mhd])$/);
  if (match) {
    const value = parseInt(match[1] ?? '', 10);
    const unit = match[2] ?? 'm';
    const ms =
      unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
    return new Date(from.getTime() + ms);
  }

  // Standard 5-field cron expression
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const parsed = parseCronExpression(parts as [string, string, string, string, string]);
    if (parsed) {
      return findNextCronMatch(parsed, from);
    }
  }

  // Default: 1 hour from now for unparsed expressions
  return new Date(from.getTime() + 3_600_000);
}

// ── Cron Parser ──

const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

interface CronField {
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): CronField | null {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim().toUpperCase();

    // Resolve named constants
    let resolved = trimmed;
    if (names) {
      for (const [name, val] of Object.entries(names)) {
        resolved = resolved.replace(name, String(val));
      }
    }

    // Star with optional step: */N or *
    const starStep = resolved.match(/^\*\/(\d+)$/);
    if (starStep) {
      const step = parseInt(starStep[1] ?? '', 10);
      if (step <= 0) return null;
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    if (resolved === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Range with optional step: N-M/S or N-M
    const rangeStep = resolved.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeStep) {
      const start = parseInt(rangeStep[1] ?? '', 10);
      const end = parseInt(rangeStep[2] ?? '', 10);
      const step = rangeStep[3] ? parseInt(rangeStep[3], 10) : 1;
      if (start < min || end > max || step <= 0) return null;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // Single value
    const num = parseInt(resolved, 10);
    if (Number.isNaN(num) || num < min || num > max) return null;
    values.add(num);
  }

  return values.size > 0 ? { values } : null;
}

function parseCronExpression(parts: [string, string, string, string, string]): ParsedCron | null {
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12, MONTH_NAMES);
  const dayOfWeek = parseCronField(parts[4], 0, 6, DAY_NAMES);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function findNextCronMatch(cron: ParsedCron, from: Date): Date {
  // Start from the next minute after `from`
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to ~2 years ahead to avoid infinite loops
  const maxIterations = 366 * 24 * 60; // ~1 year in minutes
  for (let i = 0; i < maxIterations; i++) {
    const mo = candidate.getMonth() + 1; // 1-12
    const dom = candidate.getDate(); // 1-31
    const dow = candidate.getDay(); // 0-6
    const hr = candidate.getHours(); // 0-23
    const mn = candidate.getMinutes(); // 0-59

    if (
      cron.month.values.has(mo) &&
      cron.dayOfMonth.values.has(dom) &&
      cron.dayOfWeek.values.has(dow) &&
      cron.hour.values.has(hr) &&
      cron.minute.values.has(mn)
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Fallback: 1 hour from now
  return new Date(from.getTime() + 3_600_000);
}
