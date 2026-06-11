import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const JobExecutionStatus = {
  Queued: 'queued',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  DeadLettered: 'dead_lettered',
} as const;

export type JobExecutionStatus = (typeof JobExecutionStatus)[keyof typeof JobExecutionStatus];

export const JobExecutionSource = {
  Http: 'http',
  Mcp: 'mcp',
  Flow: 'flow',
  Schedule: 'schedule',
} as const;

export type JobExecutionSource = (typeof JobExecutionSource)[keyof typeof JobExecutionSource];

/**
 * Framework job_executions table — tracks async capability job lifecycle.
 */
export const jobExecutionsTable = pgTable('job_executions', {
  id: uuid('id').primaryKey(),
  capabilityDomain: text('capability_domain').notNull(),
  capabilityName: text('capability_name').notNull(),
  status: text('status').notNull().default(JobExecutionStatus.Queued),
  inputJson: jsonb('input_json'),
  outputJson: jsonb('output_json'),
  errorJson: jsonb('error_json'),
  authSnapshotJson: jsonb('auth_snapshot_json'),
  tenantId: text('tenant_id'),
  correlationId: text('correlation_id'),
  source: text('source').notNull().default(JobExecutionSource.Http),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
