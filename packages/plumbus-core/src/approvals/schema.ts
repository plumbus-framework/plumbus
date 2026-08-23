// Tenant-local human-task / approval tables (Plan 02 Stage 4).
// v1 field subset of human-task.schema.json — opaque contract refs omitted
// until a host populates them honestly.
//
// Listed in FRAMEWORK_TABLE_NAMES. Shipped SQL lives in
// packages/plumbus-core/migrations/durable-tenant/0001_plan02_human_task.sql.
// Apply on dedicated harness DBs only; never on application tenant databases.

import { index, text, timestamp } from 'drizzle-orm/pg-core';
import { resolveFrameworkSchema, tableBuilderFor } from '../data/schema-generator.js';

export const TENANT_APPROVAL_TABLE_NAMES = [
  'human_task',
  'approval_request',
  'approval_decision',
] as const;

export function createTenantApprovalTables(schemaName?: string) {
  const table = tableBuilderFor(schemaName ?? resolveFrameworkSchema());

  const humanTask = table(
    'human_task',
    {
      humanTaskId: text('human_task_id').primaryKey(),
      kind: text('kind').notNull(),
      state: text('state').notNull(),
      approvalRequestId: text('approval_request_id'),
      executionId: text('execution_id'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    },
    (t) => [index('human_task_state_idx').on(t.state)],
  );

  const approvalRequest = table(
    'approval_request',
    {
      approvalRequestId: text('approval_request_id').primaryKey(),
      capabilityId: text('capability_id').notNull(),
      definitionVersion: text('definition_version').notNull(),
      inputDigest: text('input_digest').notNull(),
      riskClass: text('risk_class').notNull(),
      reviewReason: text('review_reason').notNull(),
      state: text('state').notNull(),
      executionId: text('execution_id'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      invalidatedReason: text('invalidated_reason'),
    },
    (t) => [
      index('approval_request_capability_idx').on(t.capabilityId),
      index('approval_request_binding_idx').on(t.capabilityId, t.definitionVersion, t.inputDigest),
    ],
  );

  const approvalDecision = table(
    'approval_decision',
    {
      approvalDecisionId: text('approval_decision_id').primaryKey(),
      approvalRequestId: text('approval_request_id').notNull(),
      approverAccountId: text('approver_account_id').notNull(),
      decision: text('decision').notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    },
    (t) => [index('approval_decision_request_idx').on(t.approvalRequestId)],
  );

  return { humanTask, approvalRequest, approvalDecision };
}
