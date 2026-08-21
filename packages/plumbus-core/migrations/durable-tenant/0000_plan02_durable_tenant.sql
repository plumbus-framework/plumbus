CREATE SCHEMA IF NOT EXISTS "core_plumbus";
--> statement-breakpoint
CREATE TABLE "core_plumbus"."execution_state" (
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
);
--> statement-breakpoint
CREATE INDEX execution_state_status_idx ON "core_plumbus"."execution_state" (status);
--> statement-breakpoint
CREATE INDEX execution_state_epoch_idx ON "core_plumbus"."execution_state" (tenant_epoch);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."step_execution" (
  step_execution_id text PRIMARY KEY,
  execution_id text NOT NULL,
  step_id text NOT NULL,
  attempt integer NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX step_execution_exec_idx ON "core_plumbus"."step_execution" (execution_id);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."wait_state" (
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
);
--> statement-breakpoint
CREATE INDEX wait_state_exec_idx ON "core_plumbus"."wait_state" (execution_id);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."terminal_state" (
  terminal_state_id text PRIMARY KEY,
  execution_id text NOT NULL UNIQUE,
  operational_state text NOT NULL,
  final_revision integer NOT NULL,
  completed_at timestamptz NOT NULL,
  domain_outcome_id text
);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."dispatch_outbox" (
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
);
--> statement-breakpoint
CREATE INDEX dispatch_outbox_pending_idx ON "core_plumbus"."dispatch_outbox" (published_at, spine_acked_at);
--> statement-breakpoint
CREATE INDEX dispatch_outbox_exec_rev_idx ON "core_plumbus"."dispatch_outbox" (execution_id, expected_revision);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."side_effect_log" (
  effect_key text PRIMARY KEY,
  label text NOT NULL,
  applied_at timestamptz NOT NULL
);
