ALTER TABLE "core_plumbus"."approval_request"
  ADD COLUMN IF NOT EXISTS tenant_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS approval_request_subject_idx ON "core_plumbus"."approval_request" (tenant_id, execution_id);
