CREATE INDEX IF NOT EXISTS execution_state_terminal_idx ON "core_plumbus"."execution_state" (updated_at) WHERE terminal = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispatch_outbox_unpublished_idx ON "core_plumbus"."dispatch_outbox" (created_at) WHERE published_at IS NULL AND spine_acked_at IS NULL AND superseded = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispatch_outbox_spine_row_idx ON "core_plumbus"."dispatch_outbox" (spine_row_id) WHERE spine_acked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispatch_outbox_acked_idx ON "core_plumbus"."dispatch_outbox" (created_at) WHERE spine_acked_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS side_effect_log_applied_idx ON "core_plumbus"."side_effect_log" (applied_at);
