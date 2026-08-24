// Drizzle table factories for Protocol A durable core.
// Tenant tables use tableBuilderFor so they land in core_plumbus when
// PLUMBUS_FRAMEWORK_SCHEMA is set. Spine tables are a separate database
// (reconstructible hints) and stay unqualified by default.
//
// SQL migrations live in packages/plumbus-core/migrations/. The two-DB harness
// applies equivalent DDL to dedicated plumbus_durable_test_* databases only.

import { boolean, index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { resolveFrameworkSchema, tableBuilderFor } from '../data/schema-generator.js';

export const TENANT_DURABLE_TABLE_NAMES = [
  'execution_state',
  'step_execution',
  'wait_state',
  'terminal_state',
  'dispatch_outbox',
  'side_effect_log',
] as const;

export const SPINE_DISPATCH_TABLE_NAME = 'opaque_dispatch';

export function createTenantDurableTables(schemaName?: string) {
  const table = tableBuilderFor(schemaName ?? resolveFrameworkSchema());

  const executionState = table(
    'execution_state',
    {
      executionId: text('execution_id').primaryKey(),
      stateRefId: text('state_ref_id').notNull(),
      tenantRef: text('tenant_ref').notNull(),
      revision: integer('revision').notNull(),
      tenantEpoch: integer('tenant_epoch').notNull(),
      status: text('status').notNull(),
      definitionId: text('definition_id').notNull(),
      definitionVersion: text('definition_version').notNull(),
      currentStepId: text('current_step_id').notNull(),
      stepIndex: integer('step_index').notNull(),
      attempt: integer('attempt').notNull(),
      correlationId: text('correlation_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      wakeAt: timestamp('wake_at', { withTimezone: true }),
      terminal: boolean('terminal').notNull(),
    },
    (t) => [
      index('execution_state_status_idx').on(t.status),
      index('execution_state_epoch_idx').on(t.tenantEpoch),
    ],
  );

  const stepExecution = table(
    'step_execution',
    {
      stepExecutionId: text('step_execution_id').primaryKey(),
      executionId: text('execution_id').notNull(),
      stepId: text('step_id').notNull(),
      attempt: integer('attempt').notNull(),
      state: text('state').notNull(),
      startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true }),
    },
    (t) => [index('step_execution_exec_idx').on(t.executionId)],
  );

  const waitState = table(
    'wait_state',
    {
      waitStateId: text('wait_state_id').primaryKey(),
      executionId: text('execution_id').notNull(),
      stepId: text('step_id').notNull(),
      kind: text('kind').notNull(),
      state: text('state').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      notBefore: timestamp('not_before', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    },
    (t) => [index('wait_state_exec_idx').on(t.executionId)],
  );

  const terminalState = table(
    'terminal_state',
    {
      terminalStateId: text('terminal_state_id').primaryKey(),
      executionId: text('execution_id').notNull(),
      operationalState: text('operational_state').notNull(),
      finalRevision: integer('final_revision').notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
      domainOutcomeId: text('domain_outcome_id'),
    },
    (t) => [uniqueIndex('terminal_state_exec_uidx').on(t.executionId)],
  );

  const dispatchOutbox = table(
    'dispatch_outbox',
    {
      outboxId: text('outbox_id').primaryKey(),
      executionId: text('execution_id').notNull(),
      stateRefId: text('state_ref_id').notNull(),
      expectedRevision: integer('expected_revision').notNull(),
      tenantEpoch: integer('tenant_epoch').notNull(),
      tenantRef: text('tenant_ref').notNull(),
      stepId: text('step_id').notNull(),
      definitionId: text('definition_id').notNull(),
      definitionVersion: text('definition_version').notNull(),
      correlationId: text('correlation_id').notNull(),
      workClassId: text('work_class_id').notNull(),
      priorityClassId: text('priority_class_id').notNull(),
      notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      publishedAt: timestamp('published_at', { withTimezone: true }),
      spineRowId: text('spine_row_id'),
      spineAckedAt: timestamp('spine_acked_at', { withTimezone: true }),
      superseded: boolean('superseded').notNull(),
    },
    (t) => [
      index('dispatch_outbox_pending_idx').on(t.publishedAt, t.spineAckedAt),
      index('dispatch_outbox_exec_rev_idx').on(t.executionId, t.expectedRevision),
    ],
  );

  const sideEffectLog = table('side_effect_log', {
    effectKey: text('effect_key').primaryKey(),
    label: text('label').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
  });

  return {
    executionState,
    stepExecution,
    waitState,
    terminalState,
    dispatchOutbox,
    sideEffectLog,
  };
}

export function createSpineDispatchTable(schemaName?: string) {
  const table = tableBuilderFor(schemaName);
  return table(
    'opaque_dispatch',
    {
      dispatchId: text('dispatch_id').primaryKey(),
      contractVersion: text('contract_version').notNull(),
      tenantRouteId: text('tenant_route_id').notNull(),
      executionId: text('execution_id').notNull(),
      definitionId: text('definition_id').notNull(),
      definitionVersion: text('definition_version').notNull(),
      stepId: text('step_id').notNull(),
      tenantExecutionStateRefId: text('tenant_execution_state_ref_id').notNull(),
      expectedRevision: integer('expected_revision').notNull(),
      tenantEpoch: integer('tenant_epoch').notNull(),
      workClassId: text('work_class_id').notNull(),
      priorityClassId: text('priority_class_id').notNull(),
      deliveryState: text('delivery_state').notNull(),
      attempt: integer('attempt').notNull(),
      notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
      leaseRefId: text('lease_ref_id'),
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
      privacySafeFailureCategoryId: text('privacy_safe_failure_category_id'),
      correlationId: text('correlation_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('opaque_dispatch_hint_uidx').on(
        t.tenantRouteId,
        t.executionId,
        t.expectedRevision,
      ),
      index('opaque_dispatch_claim_idx').on(t.deliveryState, t.notBefore, t.leaseExpiresAt),
    ],
  );
}
