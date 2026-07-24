# Session entities + schema-hash on pending actions

> **Locked.** Three entities (`ChatSession`, `ChatTurn`, `ChatPendingAction`) live in the package.

## The problem

The runtime needs persistent state to do its job:

- Per-session and per-user budgets aggregate over historical turns (cost, token count, turn count).
- Behavioral cooldowns need a place to store counters.
- Pending actions (capability-backed writes awaiting user confirmation) must survive between proposal and confirmation, including across redeploys.
- Message history (for in-window context replay) needs to be either server-persistent or client-sent.

The published spec doesn't specify storage shape — it leaves "session" as an implicit concept. Without explicit entity shape, every consumer reinvents a turn-log table, and chat-specific tools (admin dashboards, eval tooling, observability) can't compose across apps.

## How it works

Three entities live in `@plumbus/chat` and register through the standard `EntityRegistry`:

```
ChatSession        # one row per conversation
  id, chatName, userId, tenantId?, audience, locale,
  startedAt, lastTurnAt, status,
  behavioralState (jsonb),
  summaryText?, summaryTurnCount

ChatTurn           # one row per user OR assistant turn
  id, sessionId, ordinal, role, content (empty when client-persistence),
  inScope, refusalReason?, sources (jsonb of ChatSourceRef[]),
  actionRequested?, actionConfirmed?,
  tokensIn, tokensOut, costUsd, model, latencyMs, recordedAt, userId

ChatPendingAction  # one row per proposed-but-unconfirmed action
  id, sessionId, capabilityName, input, schemaHash,
  confirmationMessage, expiresAt, status
```

Standard Plumbus features apply: tenant-scoped, indexed, migrations land through Drizzle, accessible through `ctx.data.ChatSession` / `ChatTurn` / `ChatPendingAction` in capabilities.

`ChatTurn.content` defaults to empty string; the persistence-mode flag (see [message-persistence-modes.md](./message-persistence-modes.md)) controls whether the runtime writes real content or `''`.

### The `schemaHash` security check

`ChatPendingAction.schemaHash` stores a hash of the capability's input schema at proposal time. On `confirm()`, the runtime re-hashes the current schema and compares.

This protects against a real attack pattern: a model proposes an action under one schema, the user takes time to think, a redeploy tightens the schema (e.g. adds a required `confirmationPin` field), and the user confirms. Without `schemaHash` re-validation, the runtime would execute the stale input against the new schema — either crashing or, worse, silently dropping the new required field. The hash forces the rejection: "schema changed; please re-request the action."

## Tradeoffs

**What works well:**
- Budget aggregations are simple `findMany + reduce` queries.
- Admin dashboards (cost per chat, refusal rate, top abusive users) can join against these tables without bespoke per-app schemas.
- The `schemaHash` mechanism prevents a real security class of bug.
- Consumer apps register entities once at bootstrap; no per-chat schema authoring.

**What you give up:**
- Three new tables for every consumer of `@plumbus/chat`. Migration cost is real (one-time).
- The `sources` jsonb column denormalizes — citation provenance is per-turn rather than relationally linked to a corpus row. Acceptable because source identity is opaque (`src_a`, `src_b`); a normalized model would need entity-per-source-type.
- `ChatTurn.ordinal` requires careful atomic assignment in `appendTurn` (read max + insert is racy). The runtime uses `findMany + length` which is correct for in-memory test contexts and acceptable for low-concurrency PG; high-concurrency deployments should switch to `INSERT ... RETURNING` with a sequence.

## Migration note

Consumers must register these three entities in their entity boot (alongside their own). Pattern mirrors how `@plumbus/mcp` ships its system tables.

---

## Addendum (2026-07-08) — C6 schema-hash v2

**Wire format:** New pending actions store `schemaHash` as `v2:` + sha256 of the capability's JSON input schema from `ctx.capabilities.describe`. Legacy rows (unprefixed hashes) keep the old echo-compare path.

**Confirm path:** `chatConfirmAction` re-derives v2 hashes on confirm and rejects schema drift with `chat.action_schema_changed`. Input is re-validated against the live Zod schema.

**Execution gap:** `chatConfirmAction` validates and updates pending-action status but **does not call `executeCapability`** on the target capability yet. Apps must trigger real writes in their own handler after confirm succeeds. The hash machinery still prevents confirming against a schema the user never saw.

> **Update (provider-native tool calling).** This gap is closed for the new paths. Path B (`policy.toolCalling`) always executes the confirmed tool through the capability pipeline and resumes the turn; Path A can opt in via `policy.action.frameworkExecuteOnConfirm: true` (default `false` preserves the decision-only behavior described above). See [tool-calling.md](./tool-calling.md).
