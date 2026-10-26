CREATE INDEX IF NOT EXISTS opaque_dispatch_runnable_idx ON "opaque_dispatch" (created_at) WHERE delivery_state IN ('ready', 'retry-scheduled', 'leased');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS opaque_dispatch_execution_idx ON "opaque_dispatch" (execution_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS opaque_dispatch_acked_idx ON "opaque_dispatch" (created_at) WHERE delivery_state = 'acknowledged';
