import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
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
    /** Caller auth at enqueue time (roles/scopes/provider); used for step execution instead of worker auth. */
    authSnapshotJson: jsonb('auth_snapshot_json'),
    correlationId: text('correlation_id'),
    triggerEventId: text('trigger_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    /** Retained during waits as their generation; no ownership without an active lease. */
    leaseToken: uuid('lease_token'),
    waitKind: text('wait_kind'),
    replayOf: uuid('replay_of'),
    scheduleId: uuid('schedule_id'),
    scheduleTickId: uuid('schedule_tick_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** Pinned compiled definition version. Nullable for live-TS runs. */
    definitionVersion: text('definition_version'),
    /** Pinned compiled definition digest. Nullable for live-TS runs. */
    definitionDigest: text('definition_digest'),
  },
  (table) => [
    index('flow_exec_status_idx').on(table.status),
    index('flow_exec_wake_at_idx').on(table.wakeAt),
    index('flow_exec_flow_name_idx').on(table.flowName),
    index('flow_exec_tenant_idx').on(table.tenantId),
    index('flow_exec_schedule_idx').on(table.scheduleId, table.status),
    index('flow_exec_lease_idx').on(table.status, table.leaseExpiresAt),
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
    definitionHash: text('definition_hash'),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }).defaultNow().notNull(),
    revision: integer('revision').notNull().default(0),
    removed: boolean('removed').notNull().default(false),
    timezone: text('timezone'),
    overlap: text('overlap').notNull().default('allow'),
    firstRun: text('first_run').notNull().default('immediate'),
  },
  (table) => [index('flow_schedules_next_run_idx').on(table.nextRunAt)],
);

/** One durable disposition per scheduled tick, including overlap skips. */
export const flowScheduleTicksTable = pgTable(
  'flow_schedule_ticks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scheduleId: uuid('schedule_id').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    revision: integer('revision').notNull(),
    executionId: uuid('execution_id'),
    outcome: text('outcome').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('flow_schedule_tick_unique').on(table.scheduleId, table.scheduledFor)],
);
