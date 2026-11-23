# Upgrading: uploads, entity indexes, hand-written migrations, `withAuditWriter` (audit outbox removed)

Agent checklist for a consumer app moving to `@plumbus/core` 0.9.0-beta.17 (with `@plumbus/ui` 0.10.0-beta.7 and `@plumbus/api` 0.4.0-beta.7 where used). Background: [capabilities.md](./capabilities.md) (uploads), [entities.md](./entities.md) (indexes), [cli.md](./cli.md) (`plumbus migrate new`), and in the monorepo `docs/upgrading-core-0.9.md` and `docs/sdk-reference/tenant-data-planes.md` (`withAuditWriter`).

## 1. If the app used the framework audit outbox (0.9.0-beta.16)

Find it: `rg -n "createAuditOutbox|runWithAuditOutbox|relayAuditOutbox|auditOutboxTable|AUDIT_OUTBOX" .`

- [ ] Add a table of your own for held records (an entity: `id` uuid = the record id, `record` json, `attempts` number, `nextAttemptAt` timestamp, `lastError` string; index `nextAttemptAt`) to the stream of each database that holds work.
- [ ] Replace `createAuditOutbox(ctx.audit)` / `runWithAuditOutbox` with `withAuditWriter(ctx.audit, writer)` inside your transaction: the writer inserts success records into that table on the transaction (`event.id` as the key) and writes `failure`/`denied` records to the ledger at once.
- [ ] After the commit: read those ids, `createDatabaseAuditWriter(ledgerDb).writeMany(events)`, delete them. A scheduled flow (per database) relays rows that a crash or an unreachable ledger left: due rows, `FOR UPDATE SKIP LOCKED`, picked in a `WITH … AS MATERIALIZED` CTE (a plain `WHERE id IN (SELECT … LIMIT n FOR UPDATE)` can pick more than `n`).
- [ ] Drain the old `audit_outbox` (keep `PLUMBUS_AUDIT_OUTBOX_RELAY_INTERVAL_MS` set on the old release until it is empty, or copy its rows into the new table), then remove that variable.
- [ ] `plumbus migrate generate` for each stream: it emits `DROP TABLE "audit_outbox" CASCADE`; apply it only after the drain.

## 2. Files sent as base64 inside JSON

- [ ] Find them: `rg -n "base64|bytesBase64" app/capabilities`.
- [ ] Replace the field with `file: streamedUploadInput({ maxBytes, contentTypes? })` and read `input.file` as an async iterable (stream it to storage); `input.file.contentLength` when the client sent one.
- [ ] Remove `api.idempotency.required` and MCP exposure from such capabilities; the method must be POST/PUT/PATCH.
- [ ] Regenerate the client; call `fn(input, { body: file })`. Secrets among the fields travel in the `x-plumbus-input` header the client sets, never in the URL.

## 3. Indexes the entity model could not declare

- [ ] Sorts on framework columns (`created_at`), case-insensitive sorts (`lower(col)`), partial indexes, trigram search: declare them on the entity (`columnOptions`, `expressions` + `name`, `where`, `using: 'gin'` + `opclass: 'gin_trgm_ops'`), then `plumbus migrate generate`.
- [ ] For a trigram index, first `plumbus migrate new "enable trigram search"` with `CREATE EXTENSION IF NOT EXISTS pg_trgm;`, then generate.

## 4. SQL the entity model cannot express

- [ ] Triggers and functions, indexes on framework tables (`core_plumbus.*`), `ALTER TABLE … SET (autovacuum_…)`: `plumbus migrate new "<what>"`, write the SQL (statements separated by statement-breakpoint lines, idempotent where possible), `plumbus migrate apply`. Never edit a generated file for this.

## 5. Small things

- [ ] `export const onAuditWriteFailure` in `app/server.ts` now also reaches the API process; remove any workaround that wired it into the server by hand.
- [ ] `import type { AuditWriteFailure } from '@plumbus/core'` instead of deriving it from `AuditServiceConfig`.
- [ ] Remove local post-processing that rewrote `plumbus generate`'s streamed answers into `application/octet-stream`.
