CREATE TABLE "opaque_dispatch" (
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
);
--> statement-breakpoint
CREATE INDEX opaque_dispatch_claim_idx ON "opaque_dispatch" (delivery_state, not_before, lease_expires_at);
