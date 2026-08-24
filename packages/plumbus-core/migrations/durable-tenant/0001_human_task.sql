CREATE SCHEMA IF NOT EXISTS "core_plumbus";
--> statement-breakpoint
CREATE TABLE "core_plumbus"."human_task" (
  human_task_id text PRIMARY KEY,
  kind text NOT NULL,
  state text NOT NULL,
  approval_request_id text,
  execution_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX human_task_state_idx ON "core_plumbus"."human_task" (state);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."approval_request" (
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
);
--> statement-breakpoint
CREATE INDEX approval_request_capability_idx ON "core_plumbus"."approval_request" (capability_id);
--> statement-breakpoint
CREATE INDEX approval_request_binding_idx ON "core_plumbus"."approval_request" (capability_id, definition_version, input_digest);
--> statement-breakpoint
CREATE TABLE "core_plumbus"."approval_decision" (
  approval_decision_id text PRIMARY KEY,
  approval_request_id text NOT NULL,
  approver_account_id text NOT NULL,
  decision text NOT NULL,
  decided_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX approval_decision_request_idx ON "core_plumbus"."approval_decision" (approval_request_id);
