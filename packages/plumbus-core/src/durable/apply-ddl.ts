// Apply Protocol A tenant/spine DDL. Identifiers are validated then quoted.

import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { assertSafeIdentifier, quoteIdentifier } from '../tenancy/data-plane-provisioning.js';

export const PLAN02_DB_NAME_PATTERN = /^plumbus_plan02_[a-z0-9_]+$/;

export function qualifyTable(schemaName: string | undefined, tableName: string): string {
  const table = quoteIdentifier(assertSafeIdentifier(tableName, 'table'));
  const schema = schemaName?.trim();
  if (!schema || schema === 'public') return table;
  return `${quoteIdentifier(assertSafeIdentifier(schema, 'schema'))}.${table}`;
}

export function tenantDurableDdl(schemaName: string = FRAMEWORK_SCHEMA): string {
  const schema = assertSafeIdentifier(schemaName, 'schema');
  const qSchema = quoteIdentifier(schema);
  const executionState = qualifyTable(schema, 'execution_state');
  const stepExecution = qualifyTable(schema, 'step_execution');
  const waitState = qualifyTable(schema, 'wait_state');
  const terminalState = qualifyTable(schema, 'terminal_state');
  const dispatchOutbox = qualifyTable(schema, 'dispatch_outbox');
  const sideEffects = qualifyTable(schema, 'side_effect_log');

  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema};`,
    `CREATE TABLE ${executionState} (
      execution_id text PRIMARY KEY,
      state_ref_id text NOT NULL,
      tenant_ref text NOT NULL,
      revision integer NOT NULL,
      tenant_epoch integer NOT NULL,
      status text NOT NULL,
      definition_id text NOT NULL,
      definition_version text NOT NULL,
      current_step_id text NOT NULL,
      step_index integer NOT NULL,
      attempt integer NOT NULL,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      wake_at timestamptz,
      terminal boolean NOT NULL
    );`,
    `CREATE INDEX execution_state_status_idx ON ${executionState} (status);`,
    `CREATE INDEX execution_state_epoch_idx ON ${executionState} (tenant_epoch);`,
    `CREATE TABLE ${stepExecution} (
      step_execution_id text PRIMARY KEY,
      execution_id text NOT NULL,
      step_id text NOT NULL,
      attempt integer NOT NULL,
      state text NOT NULL,
      started_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      completed_at timestamptz
    );`,
    `CREATE INDEX step_execution_exec_idx ON ${stepExecution} (execution_id);`,
    `CREATE TABLE ${waitState} (
      wait_state_id text PRIMARY KEY,
      execution_id text NOT NULL,
      step_id text NOT NULL,
      kind text NOT NULL,
      state text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      not_before timestamptz,
      expires_at timestamptz,
      resolved_at timestamptz
    );`,
    `CREATE INDEX wait_state_exec_idx ON ${waitState} (execution_id);`,
    `CREATE TABLE ${terminalState} (
      terminal_state_id text PRIMARY KEY,
      execution_id text NOT NULL UNIQUE,
      operational_state text NOT NULL,
      final_revision integer NOT NULL,
      completed_at timestamptz NOT NULL,
      domain_outcome_id text
    );`,
    `CREATE TABLE ${dispatchOutbox} (
      outbox_id text PRIMARY KEY,
      execution_id text NOT NULL,
      state_ref_id text NOT NULL,
      expected_revision integer NOT NULL,
      tenant_epoch integer NOT NULL,
      tenant_ref text NOT NULL,
      step_id text NOT NULL,
      definition_id text NOT NULL,
      definition_version text NOT NULL,
      correlation_id text NOT NULL,
      work_class_id text NOT NULL,
      priority_class_id text NOT NULL,
      not_before timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      published_at timestamptz,
      spine_row_id text,
      spine_acked_at timestamptz,
      superseded boolean NOT NULL
    );`,
    `CREATE INDEX dispatch_outbox_pending_idx ON ${dispatchOutbox} (published_at, spine_acked_at);`,
    `CREATE INDEX dispatch_outbox_exec_rev_idx ON ${dispatchOutbox} (execution_id, expected_revision);`,
    `CREATE TABLE ${sideEffects} (
      effect_key text PRIMARY KEY,
      label text NOT NULL,
      applied_at timestamptz NOT NULL
    );`,
  ].join('\n');
}

/** Existing event outbox — tenant-local; the dispatcher polls each tenant copy. */
export function eventOutboxDdl(): string {
  return `
CREATE TABLE event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  version text NOT NULL DEFAULT '1',
  payload jsonb NOT NULL,
  actor text NOT NULL,
  tenant_id text,
  correlation_id text NOT NULL,
  causation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending',
  dispatched_at timestamptz,
  retry_count text NOT NULL DEFAULT '0',
  last_error text
);
CREATE INDEX event_outbox_status_idx ON event_outbox (status);
CREATE INDEX event_outbox_occurred_at_idx ON event_outbox (occurred_at);
`;
}

/** Tenant-local delivery tables the event worker and idempotency service use. */
export function eventDeliveryDdl(): string {
  return `
CREATE TABLE event_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  consumer_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_idempotency_event_consumer_idx ON event_idempotency (event_id, consumer_id);
CREATE TABLE event_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  consumer_id text,
  last_error text,
  retry_count text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);
`;
}

export function spineDispatchDdl(): string {
  const table = qualifyTable(undefined, 'opaque_dispatch');
  return [
    `CREATE TABLE ${table} (
      dispatch_id text PRIMARY KEY,
      contract_version text NOT NULL,
      tenant_route_id text NOT NULL,
      execution_id text NOT NULL,
      definition_id text NOT NULL,
      definition_version text NOT NULL,
      step_id text NOT NULL,
      tenant_execution_state_ref_id text NOT NULL,
      expected_revision integer NOT NULL,
      tenant_epoch integer NOT NULL,
      work_class_id text NOT NULL,
      priority_class_id text NOT NULL,
      delivery_state text NOT NULL,
      attempt integer NOT NULL,
      not_before timestamptz NOT NULL,
      lease_ref_id text,
      lease_expires_at timestamptz,
      privacy_safe_failure_category_id text,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (tenant_route_id, execution_id, expected_revision)
    );`,
    `CREATE INDEX opaque_dispatch_claim_idx ON ${table} (delivery_state, not_before, lease_expires_at);`,
  ].join('\n');
}

/** Existing flow engine table — tenant-local copy so start/runNext stay on one engine. */
export function flowExecutionsDdl(): string {
  return `
CREATE TABLE flow_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_name text NOT NULL,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  input jsonb NOT NULL,
  state jsonb,
  current_step text,
  step_history jsonb NOT NULL DEFAULT '[]',
  retry_count integer NOT NULL DEFAULT 0,
  last_error text,
  waiting_for_event text,
  wake_at timestamptz,
  actor text NOT NULL,
  tenant_id text,
  auth_snapshot_json jsonb,
  correlation_id text,
  trigger_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  definition_version text,
  definition_digest text
);
CREATE INDEX flow_exec_status_idx ON flow_executions (status);
CREATE INDEX flow_exec_lease_idx ON flow_executions (status, lease_expires_at);
CREATE TABLE flow_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL UNIQUE,
  flow_name text NOT NULL,
  input jsonb NOT NULL,
  state jsonb,
  step_history jsonb,
  last_error text,
  retry_count integer NOT NULL DEFAULT 0,
  failed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);
`;
}

export function tenantApprovalDdl(schemaName: string = FRAMEWORK_SCHEMA): string {
  const schema = assertSafeIdentifier(schemaName, 'schema');
  const qSchema = quoteIdentifier(schema);
  const humanTask = qualifyTable(schema, 'human_task');
  const approvalRequest = qualifyTable(schema, 'approval_request');
  const approvalDecision = qualifyTable(schema, 'approval_decision');

  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema};`,
    `CREATE TABLE ${humanTask} (
      human_task_id text PRIMARY KEY,
      kind text NOT NULL,
      state text NOT NULL,
      approval_request_id text,
      execution_id text,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      resolved_at timestamptz
    );`,
    `CREATE INDEX human_task_state_idx ON ${humanTask} (state);`,
    `CREATE TABLE ${approvalRequest} (
      approval_request_id text PRIMARY KEY,
      capability_id text NOT NULL,
      definition_version text NOT NULL,
      input_digest text NOT NULL,
      risk_class text NOT NULL,
      review_reason text NOT NULL,
      state text NOT NULL,
      execution_id text,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      resolved_at timestamptz,
      invalidated_reason text
    );`,
    `CREATE INDEX approval_request_capability_idx ON ${approvalRequest} (capability_id);`,
    `CREATE INDEX approval_request_binding_idx ON ${approvalRequest} (capability_id, definition_version, input_digest);`,
    `CREATE TABLE ${approvalDecision} (
      approval_decision_id text PRIMARY KEY,
      approval_request_id text NOT NULL,
      approver_account_id text NOT NULL,
      decision text NOT NULL,
      decided_at timestamptz NOT NULL
    );`,
    `CREATE INDEX approval_decision_request_idx ON ${approvalDecision} (approval_request_id);`,
  ].join('\n');
}

export function tenantEpochTableDdl(schemaName: string = FRAMEWORK_SCHEMA): string {
  const table = qualifyTable(schemaName, 'tenant_epoch');
  return `CREATE TABLE ${table} (
    tenant_ref text PRIMARY KEY,
    epoch integer NOT NULL
  );`;
}
