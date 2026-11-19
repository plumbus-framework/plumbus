# Upgrading: bounded repository reads and lazily opened transactions

Agent checklist for a consumer app moving to a core 0.9 beta that has both changes (core after
0.9.0-beta.12). Do the steps in order; each says how to find the code it concerns. Background:
[entities.md](./entities.md) (reads), [capabilities.md](./capabilities.md) § When the transaction
opens, and `docs/upgrading-core-0.9.md` in the monorepo.

## 1. Repository reads

Nothing throws after the upgrade: the read ceiling starts in `warn` mode. Four things change at once:

- [ ] **Empty `in` lists now match no rows** (they used to drop the filter and match every row).
      Find them: `rg -n "in: *\{" app packages` and every `options.in` built from a variable. Where
      an empty list meant "no filter", leave the key out: `...(ids.length ? { in: { id: ids } } : {})`.
      Where it meant "none of these", delete the guard you wrote around it if you like — it is no
      longer needed.
- [ ] **`limit` is honoured exactly.** `limit: 500` returns up to 500 rows (it returned 100);
      `limit: 0` returns none (it returned one); a negative or fractional `limit` throws
      `DataValidationError`. Find them: `rg -n "limit: *[0-9]" app packages` and every `limit:` fed
      from input. Check that input schemas bound a caller-supplied page size (`z.number().int().max(100)`).
- [ ] **A `limit` above the read ceiling** (default 1000) is honoured and logged (`warn`), or
      refused before any query (`error`). Where the code really needs more, add `unbounded: true`
      before switching to `error`. Nothing caps a caller-supplied `limit` in `warn` mode any more
      (the old 100 clamp did): bound it in the capability's input schema.
- [ ] **Unlimited reads past the ceiling are logged** with their call site:
      `Repository read went past the read ceiling; …` with `entity`, `operation`, `rows`, `stack`.

Find the reads that would trip, in this order:

1. Deploy with the default (`PLUMBUS_READ_CEILING_MODE=warn`) and collect the warnings from
   staging and production logs. Each names the entity, the row count and the calling frames. These
   are the reads that load more than the ceiling **today**.
2. Find the reads that will grow past it: in a staging or test environment with realistic seed
   data, run with a low ceiling (`PLUMBUS_READ_CEILING=50`, still `warn`) and exercise the app; every
   read returning more than a page shows up.
3. Statically, every `findMany(` / `findManyFields(` call without `limit` is a candidate:
   `rg -n "\.findMany(Fields)?\(" app packages | rg -v "limit|unbounded"` (multi-line calls need a
   look by hand). Sum or exists checks done in JS on the result (`.length`, `.reduce`, `.some`,
   `.find`) are the first to fix.
4. In unit tests, `createTestContext({ readCeiling: createReadCeilingPolicy({ maxRows: 50, mode: 'error' }) })`
   with fixtures above 50 rows makes an unbounded read fail the test.

Fix each one, by what the code needs:

| The code wants | Use |
|----------------|-----|
| one row by a key | a filter on the key, `limit: 1` (or `findById`) |
| a number / a yes-no | `count`, `exists!`, `aggregate` (`sum`, `countDistinct`, `groupBy`) |
| a page for a UI | `limit` + `offset`, or `findPage!` for deep or live lists |
| every row of a set that grows | a `findPage!` loop (keyset, `nextCursor`) |
| every row of a set known to stay small | `{ unbounded: true }` and a comment saying why |

Repositories the app builds itself with `createRepository(...)` (per-tenant stores, packages) use the
framework default policy (1000 rows, `warn`, `console.warn`) unless given one: pass
`readCeiling: entities.getReadCeiling()` (the registry `createServer` configured) or
`readCeilingPolicyFromConfig(config.data, (m, meta) => logger.warn(m, meta))`.

- [ ] When the warnings stop, set `PLUMBUS_READ_CEILING_MODE=error` (or `data.readCeilingMode:
      'error'`). From then on an over-ceiling read is refused with `DataReadCeilingError` instead of
      loading the table.

## 2. Capability transactions

Actions and event handlers now open their transaction at the first write (data mutation, event,
durable flow start, job) instead of before the handler. Writes stay atomic. Check:

- [ ] `SHOW default_transaction_isolation;` on the app's database (and `ALTER ROLE … SET` /
      `ALTER DATABASE … SET` overrides). At `read committed` (the PostgreSQL default) nothing a
      handler sees through `ctx.data` changes. At `repeatable read` or `serializable`, reads before
      the first write no longer share the transaction's snapshot: set
      `PLUMBUS_TRANSACTION_BEGIN=eager`, or `transactional: 'eager'` on the capabilities that rely on it.
- [ ] `rg -n "transactionScope" app packages` — code using the internal
      `ctx.__runtime.transactionScope.db` handle gets `undefined` until something opened the
      transaction. Use `await ctx.__runtime.transactionScope.acquire()` or set `transactional: 'eager'`
      on that capability. (Prefer `ctx.data`; the handle is internal.)
- [ ] `transactional: false` annotations added only so a capability would not hold a connection
      while it worked elsewhere are no longer needed for that reason. Leave them (they are still
      valid) or remove them where the capability's writes should be atomic.
- [ ] Opening a transaction now waits at most 10 s for a pool connection; past it the call fails
      with HTTP 503 (`reason: 'pool-acquire-timeout'`, `Retry-After`). Watch for it in logs; size
      `DATABASE_POOL_SIZE` against concurrent writers; set `PLUMBUS_TRANSACTION_ACQUIRE_TIMEOUT_MS=0`
      to wait without limit as before. Set `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` too.
- [ ] Tests that count `db.transaction` calls or expect a transaction for a handler that writes
      nothing need updating; `createTestContext` has no transaction runner and is unaffected.

To roll back to the earlier behaviour without code changes: `PLUMBUS_TRANSACTION_BEGIN=eager` and
`PLUMBUS_TRANSACTION_ACQUIRE_TIMEOUT_MS=0`. Reads have no full rollback switch for the empty `in`
and exact `limit` fixes; `PLUMBUS_READ_CEILING_MODE=warn` (the default) keeps unlimited reads
returning every row.
