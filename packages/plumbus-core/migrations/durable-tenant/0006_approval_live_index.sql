-- plumbus:no-transaction
-- The approval service reads live requests (pending or approved) for one tenant, execution
-- and capability on every request and gate check. Built concurrently so a large
-- approval_request table keeps taking writes while it builds; re-runnable (IF NOT EXISTS).
CREATE INDEX CONCURRENTLY IF NOT EXISTS approval_request_live_idx ON "core_plumbus"."approval_request" (tenant_id, execution_id, capability_id) WHERE state IN ('pending', 'approved');
