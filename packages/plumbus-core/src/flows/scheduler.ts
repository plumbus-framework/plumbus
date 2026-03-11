import { eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { LoggerService } from "../types/context.js";
import type { AuthContext } from "../types/security.js";
import type { createFlowEngine } from "./engine.js";
import { FlowRegistry } from "./registry.js";
import { flowSchedulesTable } from "./schema.js";

export interface SchedulerConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  engine: ReturnType<typeof createFlowEngine>;
  /** Optional logger for error reporting */
  logger?: LoggerService;
  /** Poll interval in milliseconds (default: 60000 = 1 min) */
  pollIntervalMs?: number;
}

/**
 * Simple cron-like scheduler that polls for flows whose nextRunAt has passed.
 * Uses the flow_schedules table to track run state.
 *
 * Note: This is a simplified implementation. For production use, consider
 * a proper cron parser library (e.g., cron-parser) for nextRunAt computation.
 */
export function createFlowScheduler(config: SchedulerConfig) {
  const { db, registry, engine, logger, pollIntervalMs = 60_000 } = config;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const systemAuth: AuthContext = {
    userId: "system-scheduler",
    roles: ["system"],
    scopes: [],
    provider: "scheduler",
  };

  /**
   * Sync registered flows with schedules into the database.
   * Call once at startup to ensure all scheduled flows have a row.
   */
  async function syncSchedules(): Promise<number> {
    const scheduled = registry.getScheduled();
    let synced = 0;

    for (const flow of scheduled) {
      if (!flow.schedule?.cron) continue;

      const existing = await db
        .select()
        .from(flowSchedulesTable)
        .where(eq(flowSchedulesTable.flowName, flow.name))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(flowSchedulesTable).values({
          flowName: flow.name,
          cron: flow.schedule.cron,
          nextRunAt: new Date(), // first run immediately
        });
        synced++;
      }
    }

    return synced;
  }

  /**
   * Run a single poll cycle: find due schedules and start flows.
   */
  async function poll(): Promise<number> {
    const now = new Date();
    const dueSchedules = await db
      .select()
      .from(flowSchedulesTable)
      .where(lte(flowSchedulesTable.nextRunAt, now));

    let triggered = 0;
    for (const schedule of dueSchedules) {
      if (!schedule.enabled) continue;

      try {
        await engine.start(schedule.flowName, {}, systemAuth);
        // Update last/next run times
        await db
          .update(flowSchedulesTable)
          .set({
            lastRunAt: now,
            nextRunAt: computeNextRun(schedule.cron, now),
          })
          .where(eq(flowSchedulesTable.id, schedule.id));
        triggered++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error(`Scheduler failed to start flow "${schedule.flowName}"`, {
          flowName: schedule.flowName,
          scheduleId: schedule.id,
          error: message,
        });
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
export function computeNextRun(cron: string, from: Date): Date {
  // Parse simple interval patterns like "every:60m", "every:24h", "every:1d"
  const match = cron.match(/^every:(\d+)([mhd])$/);
  if (match) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const ms =
      unit === "m" ? value * 60_000 :
      unit === "h" ? value * 3_600_000 :
      value * 86_400_000;
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
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
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

function parseCronField(field: string, min: number, max: number, names?: Record<string, number>): CronField | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
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
      const step = parseInt(starStep[1]!, 10);
      if (step <= 0) return null;
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    if (resolved === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Range with optional step: N-M/S or N-M
    const rangeStep = resolved.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeStep) {
      const start = parseInt(rangeStep[1]!, 10);
      const end = parseInt(rangeStep[2]!, 10);
      const step = rangeStep[3] ? parseInt(rangeStep[3], 10) : 1;
      if (start < min || end > max || step <= 0) return null;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // Single value
    const num = parseInt(resolved, 10);
    if (isNaN(num) || num < min || num > max) return null;
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
    const dom = candidate.getDate();     // 1-31
    const dow = candidate.getDay();      // 0-6
    const hr = candidate.getHours();     // 0-23
    const mn = candidate.getMinutes();   // 0-59

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
