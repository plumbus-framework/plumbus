# Upgrading: streamed answers, audit outbox, per-row bulk insert audit, `notIn`, audit failure hook

Agent checklist for a consumer app moving to `@plumbus/core` 0.9.0-beta.16 (with `@plumbus/ui` 0.10.0-beta.6 and `@plumbus/api` 0.4.0-beta.6 where used) from 0.9.0-beta.15. Do the steps
in order; each says how to find the code it concerns. Background:
[capabilities.md](./capabilities.md) (streamed answers), [entities.md](./entities.md)
(`createMany`, `notIn`), [events.md](./events.md) (dead letters), and in the monorepo
`docs/upgrading-core-0.9.md` and `docs/sdk-reference/tenant-data-planes.md` (audit outbox).

## 1. What changes without any code change

- [ ] **`plumbus migrate generate` emitted `audit_outbox` in 0.9.0-beta.16** (removed again in
      0.9.0-beta.17; see the newer checklist before generating).
- [ ] **A custom `Repository` implementation** (rare: `rg -n "implements Repository|: Repository<" app packages`)
      now receives `notIn` among the filters and an options argument to `createMany`. Apply
      `notIn` (or refuse it); never ignore it, or a `deleteMany` would match more rows than asked.

## 2. Files answered as one JSON body

- [ ] Find capabilities whose output carries file bytes: `rg -n "bytesBase64|base64|archive: z\.|Buffer\.from\(.*base64" app/capabilities`.
- [ ] For each download, declare `output: streamedBodyOutput` and return
      `streamedBody(source, { contentType, contentLength?, fileName? })` where `source` is a
      `Readable` or an async generator of `Uint8Array` chunks (decrypt or read in chunks; never
      build the whole file).
- [ ] Remove `api.idempotency.required` and `exposeAs: ['mcp']` from those capabilities (refused).
- [ ] In an **action** the source is read after its transaction committed: do not read through
      the transaction's `ctx.data` in the source; read storage or open your own connection.
- [ ] Regenerate the client (`plumbus ui generate`). The function now returns the `Response`:
      replace `const { archive } = await downloadX(input)` with
      `const response = await downloadX(input); const blob = await response.blob();`
      (or stream `response.body` to a file).

## 3. Audit records of writes on a tenant plane

The framework audit outbox described here in 0.9.0-beta.16 was removed in 0.9.0-beta.17. Follow
[upgrading-uploads-indexes-and-migrations.md](./upgrading-uploads-indexes-and-migrations.md) § 1
(`withAuditWriter` and a table of your own).

## 4. Bulk inserts and exclusion filters

- [ ] Find inserts in loops: `rg -n "for \(const .* of .*\)[^{]*\{?\s*await .*\.(create|insert)\(" app packages`.
      Replace with `createMany(batch, { audit: 'per-row' })` in batches of a few hundred where
      each record must keep its own audit row, or `createMany(batch)` where one summary row is
      enough.
- [ ] Find code that reads rows only to drop some in memory before writing
      (`.filter((row) => !held.has(row.x))` before a delete or update). Use
      `notIn: { x: [...held] }` in `findMany` / `deleteMany` / `updateMany` instead. A NULL column
      never matches `notIn`.

## 5. Alerts on lost audit records

- [ ] Export from `app/server.ts`:

      ```ts
      export function onAuditWriteFailure(failure: AuditWriteFailure): void {
        // count it; raise an alert when failure.final is true (the record is lost)
      }
      ```

      It reaches the request, worker and event-handler audit services and the outbox relay.
      Remove log-line alerts written only to catch `[plumbus] audit record …` if this replaces them.

## 6. Settling old dead letters on tenant planes

- [ ] See what is there: `plumbus events dead-letter list --all-tenants --limit 50`.
- [ ] Settle what nobody will redeliver (with the owner's agreement), e.g.
      `plumbus events dead-letter resolve-all --event-type <type> --before <iso-date> --all-tenants --note "<why>"`.
      Resolved rows are then removed by framework retention (`frameworkRetention.eventDeadLetter`).
