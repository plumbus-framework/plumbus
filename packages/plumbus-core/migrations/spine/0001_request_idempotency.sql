CREATE TABLE IF NOT EXISTS "request_idempotency" (
  key_hash text PRIMARY KEY,
  principal_id text NOT NULL,
  tenant_scope text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL,
  claim_token uuid,
  lease_expires_at timestamptz,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS request_idempotency_expires_idx ON "request_idempotency" (expires_at);
