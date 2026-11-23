# Upgrading: set-based writes, idempotency records per plane, success audit rows

Agent checklist for a consumer app moving to a core 0.9 beta after 0.9.0-beta.14. Do the steps
in order; each says how to find the code it concerns. Background: [entities.md](./entities.md)
(set-based writes, `contains`), [capabilities.md](./capabilities.md) (audit rows),
[api.md](./api.md) (idempotency records), and `docs/upgrading-core-0.9.md` in the monorepo.

## 1. What changes without any code change

- [ ] **Success audit rows.** A transactional action's `capability.<name>` success row is now
      written inside its transaction. An action without a framework transaction
      (`transactional: false`, AI or external effects) no longer fails with
      `Audit persistence failed` when its success row cannot be written: the row is retried and
      an error is logged. Add an alert on the log lines `[plumbus] audit record could not be
      written` and `[plumbus] audit record lost` (or pass `onWriteFailure` where the app builds
      its own `createAuditService`). Queries, denied and failed calls behave as before.
- [ ] **`in` lists** on uuid, text, integer and similar columns are sent as one array parameter.
      Results are the same; delete any chunking you wrote only to stay under 65,535 parameters.
- [ ] **`plumbus migrate generate` emits `core_plumbus.request_idempotency`.** Run it, review the
      new migration, apply it. If a database already has that table from
      `requestIdempotencyDdl('core_plumbus')` or the shipped `durable-tenant/0003` SQL, generate
      with that database reachable (the generator then leaves the table alone) or remove the
      `CREATE TABLE` from the generated file.

## 2. Replace load-then-loop writes

- [ ] Find deletes and updates in loops: `rg -n "for \(const .* of .*\) *\{?\s*await .*\.(delete|update)\(" app packages`
      and look for `findMany(` followed by a loop of `delete(`/`update(`. Replace each with
      `deleteMany!(query, { …filters, limit })` / `updateMany!(query, values, { …filters, limit })`
      and loop while `count === limit` (for `updateMany`, filter out rows already changed).
- [ ] Keep the default per-row audit unless the per-record trail is not needed; then pass
      `audit: 'summary'` and say why in a comment.
- [ ] Reads that filter JSON arrays in JavaScript (`rows.filter((r) => r.assetIds.includes(id))`):
      use `contains: { assetIds: [id] }` and declare `indexes: [{ columns: ['assetIds'], using: 'gin' }]`
      on the entity, then `plumbus migrate generate` (build the index `CONCURRENTLY` on a large table).
- [ ] Saves whose result is ignored on wide rows: `update(id, values, { returning: false })`.
- [ ] Code that wraps `createRepository` (a bound or package repository) can call `findPage`,
      `exists`, `deleteMany`, `updateMany` without `!`: `createRepository` returns `FrameworkRepository`.

## 3. Idempotency records on the tenant's plane (hosts with `requestDataPlane: 'control-plane'`)

- [ ] If the app keeps request repositories on the control plane but tenant data on tenant
      databases, export the store with `resolveDatabase` returning the tenant's plane (lease it,
      return `release`). See [api.md](./api.md) § Choosing the database per request.
- [ ] Make sure every tenant plane has `core_plumbus.request_idempotency` (step 1).

## 4. Optional

- [ ] Actions that run their own database transaction outside the framework's
      (`transactional: false`): `audit: { event, deferSuccess: true }`.
- [ ] High-volume actions whose data rows already record what they did:
      `audit: { event, success: false }`.
- [ ] Admission locks that only need to exclude a rare exclusive operation:
      `withRequestAdmissionLock(db, key, work, { mode: 'shared', lockTimeoutMs })`; delete a
      hand-written `pg_advisory_xact_lock_shared` over the framework's key.
- [ ] Hosts with many tenant planes on one database server:
      `createPooledDataPlaneResolver({ maxTotalConnections })` and pass `connectionBudget` through
      `connect` to `openDataPlaneConnection`; per-pool `sessionSettings: { jit: 'off' }`.
- [ ] Approval lookups by many ids: `store.getRequests!(ids)` instead of a `getRequest` loop.

## 5. Verify

- [ ] `plumbus test`, then a staging run with the log alert from step 1 in place.
