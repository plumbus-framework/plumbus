import { createRequire } from 'node:module';
import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';
import type { FlowSchedule } from '../types/flow.js';

const require = createRequire(import.meta.url);
export const scheduleSchema = z
  .object({
    cron: z.string().min(1),
    timezone: z.string().optional(),
    firstRun: z.enum(['immediate', 'next']).optional(),
    overlap: z.enum(['allow', 'skip']).optional(),
  })
  .strict();
export function computeNextRun(cron: string, from: Date, timezone?: string): Date {
  if (!Number.isFinite(from.getTime()))
    throw new DataValidationError('Invalid schedule reference date');
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format(from);
    } catch {
      throw new DataValidationError('Invalid schedule timezone', { timezone });
    }
  }
  const interval = /^every:(\d+)([mhd])$/.exec(cron);
  if (interval) {
    const value = Number(interval[1]);
    const milliseconds =
      value * (interval[2] === 'm' ? 60000 : interval[2] === 'h' ? 3600000 : 86400000);
    const next = new Date(from.getTime() + milliseconds);
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(next.getTime()))
      throw new DataValidationError('Invalid schedule interval', { cron });
    return next;
  }
  try {
    const parser = require('cron-parser') as {
      parseExpression(
        expression: string,
        options: { currentDate: Date; tz?: string },
      ): { next(): { toDate(): Date } };
    };
    return parser.parseExpression(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    throw new DataValidationError('Invalid cron expression', { cron });
  }
}
export function validateSchedule(schedule: FlowSchedule, flowName: string): void {
  const parsed = scheduleSchema.safeParse(schedule);
  if (!parsed.success)
    throw new DataValidationError('Invalid flow schedule', {
      flowName,
      issues: parsed.error.issues,
    });
  try {
    computeNextRun(schedule.cron, new Date(), schedule.timezone);
  } catch {
    throw new DataValidationError('Invalid flow schedule expression or timezone', {
      flowName,
      cron: schedule.cron,
      timezone: schedule.timezone,
    });
  }
}
