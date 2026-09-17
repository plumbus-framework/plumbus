ALTER TABLE "core_plumbus"."approval_request"
  ADD COLUMN IF NOT EXISTS cancelled_by_account_id text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;
