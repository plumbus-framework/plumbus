import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Flow execution state — one row per flow execution instance.
 * Tracks current status, step history, shared state, and retry info.
 */
export const flowExecutionsTable = pgTable(
  'flow_executions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    flowName: text('flow_name').notNull(),
    domain: text('domain').notNull(),
    status: text('status').notNull().default('created'),
    // created | running | waiting | completed | failed | cancelled
    input: jsonb('input').notNull(),
    state: jsonb('state'), // shared mutable state across steps
    currentStep: text('current_step'),
    stepHistory: jsonb('step_history').notNull().default('[]'),
    // Array of { step, status, startedAt, completedAt, error? }
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    waitingForEvent: text('waiting_for_event'),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    actor: text('actor').notNull(),
    tenantId: text('tenant_id'),
    correlationId: text('correlation_id'),
    triggerEventId: text('trigger_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('flow_exec_status_idx').on(table.status),
    index('flow_exec_wake_at_idx').on(table.wakeAt),
    index('flow_exec_flow_name_idx').on(table.flowName),
    index('flow_exec_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Flow dead-letter table — executions that exhausted retries.
 */
export const flowDeadLetterTable = pgTable('flow_dead_letter', {
  id: uuid('id').defaultRandom().primaryKey(),
  executionId: text('execution_id').notNull().unique(),
  flowName: text('flow_name').notNull(),
  input: jsonb('input').notNull(),
  state: jsonb('state'),
  stepHistory: jsonb('step_history'),
  lastError: text('last_error'),
  retryCount: integer('retry_count').notNull().default(0),
  failedAt: timestamp('failed_at', { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb('metadata'),
});

/**
 * Flow schedules table — tracks scheduled flow run state to prevent duplicate runs.
 */
export const flowSchedulesTable = pgTable(
  'flow_schedules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    flowName: text('flow_name').notNull().unique(),
    cron: text('cron').notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
  },
  (table) => [index('flow_schedules_next_run_idx').on(table.nextRunAt)],
);
