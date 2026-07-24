# Confirmation persistence and migration

Pending chat actions are lease-committed with a session `revision` compare-and-set (CAS). The `/turn` route refuses a second turn while a `pending` or `confirming` action exists (HTTP 409 with `chat.pending_action_exists` or `chat.session_busy`). Expired `pending` rows are terminalized inline and the turn proceeds.

Confirmation executes the capability through `executeCapability` (access policy enforced) using the normalized stored input from the pending row — never client-supplied capability name or input.

## Entity migration order

After updating `@plumbus/chat` entity definitions, regenerate schema and run migrations in your app:

1. **`ChatSession`** gains `revision INTEGER NOT NULL DEFAULT 0`, `lease_token TEXT`, `lease_expires_at TIMESTAMPTZ`. The `DEFAULT 0` backfills existing rows; no manual backfill needed.

2. **`ChatTurn`** gains `logical_turn_id TEXT`, `continuation_of_turn_id TEXT`, `tools_executed JSONB`, then the **unique** index `chat_turn_session_id_ordinal_idx`. Generated DDL adds the columns first; the unique index is safe on existing data because `(session_id, ordinal)` was already logically unique (assigned by `appendTurn` from `existing.length`).

3. **`ChatPendingAction`** is a transient (≤15 min TTL) table: `schema_hash` is replaced by `input_schema_hash` + `tool_binding_hash`, `status` gains `confirming` / `failed` / `indeterminate`, and `version` / `expected_session_revision` / `attempt_id` / `claimed_at` / `execution_started_at` / `completed_at` / `resume_payload` / `confirmation_projection` are added. Regenerate with `plumbus migrate` after `plumbus generate`; no data migration is required for rows that will expire.

## Storage requirements

`ChatConversationStore` requires `Repository.updateWhere` on `ChatSession` and `ChatPendingAction`. Adapters without conditional writes fail closed at startup with `chat.storage_unsupported`.
