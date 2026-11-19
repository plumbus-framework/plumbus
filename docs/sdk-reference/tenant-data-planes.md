# Tenant Data Planes

A **data plane** is one tenant's database, opened as one named role. The host application owns routing (which tenant lives where). The framework owns provisioning, opening connections, and applying schema.

This page is the host story: create the database, apply generated migrations as the owner, then run request traffic as the runtime role.

Related: [Security model](../security/security-model.md#database-per-tenant-data-planes) · [Credential catalog](./credential-catalog.md) · [Data layer migrations](./data-layer.md#migrations) · [CLI migrate](../cli/commands.md#plumbus-migrate)

## Why two roles

`provisionDataPlane` creates:

| Role | Who uses it | What it may do |
|------|-------------|----------------|
| **Owner** | Migrate jobs, schema apply | DDL and DML. Owns the database and its schemas. |
| **Runtime** | Request-time resolver / capabilities | DML only. A routing mistake fails to connect or to mutate schema, not another tenant's rows. |

Do not apply migrations as the runtime role. It cannot run `CREATE TABLE` / `ALTER TABLE`.

`--create-db` on the CLI is not this story. It only issues `CREATE DATABASE` with the config user. It does not create the owner/runtime pair. For a tenant data plane, call `provisionDataPlane` first.

## Host sequence

```
1. provisionDataPlane(...)     create database + owner + runtime
2. apply as owner              generated drizzle/ SQL on that named database
3. resolve as runtime          createPooledDataPlaneResolver + openDataPlaneConnection
```

### 1. Provision

```typescript
import { provisionDataPlane } from "@plumbus/core";

const plane = await provisionDataPlane({
  adminConnection: clusterAdmin,
  databaseName: "tenant_alpha",
  ownerRole: { name: "tenant_alpha_owner", password: ownerPassword },
  runtimeRole: { name: "tenant_alpha_runtime", password: runtimePassword },
});
```

Identifiers are validated and quoted. The call is idempotent: a retry after a partial failure reports `created` or `already-present` per step.

### 2. Apply generated migrations as the owner

Generate SQL once for the app (`plumbus migrate generate`). Apply that same folder to **each** tenant database.

**Programmatic (host provision job):**

```typescript
import { applyDataPlaneMigrations, openDataPlaneConnection } from "@plumbus/core";

const result = await applyDataPlaneMigrations({
  target: {
    host: cluster.host,
    port: cluster.port,
    database: plane.databaseName,
    user: plane.ownerRole,
    password: ownerPassword,
  },
  migrationsFolder: "./drizzle",
});
// result: { applied, tags, database }
```

`applyDataPlaneMigrations` is a thin compose of `openDataPlaneConnection` (the existing factory) and `applyMigrations`. It always closes the pool, including when apply fails. Concurrent applies to the same tenant database wait on that database's migration advisory lock (one reserved connection, so the default pool of one is enough); different tenant databases do not wait on each other. Credentials never appear in factory errors.

Equivalent composition if you already hold a connection:

```typescript
const { db, close } = await openDataPlaneConnection({
  target: { host, port, database: plane.databaseName, user: plane.ownerRole, password: ownerPassword },
  maxConnections: 1,
  applicationName: "plumbus-migrate",
});
try {
  await applyMigrations({ db, migrationsFolder: "./drizzle" });
} finally {
  await close();
}
```

**CLI (operator / one-off):**

```bash
plumbus migrate apply --database tenant_alpha
```

`--database` selects the Postgres database name. Host, port, and user still come from config — point those at the **owner** role for that tenant when you run apply. JSON output includes `"database"`.

The same flag exists on `migrate push`, `migrate rollback`, and `migrate reconcile`.

`--create-db --database tenant_alpha` creates an empty database with the config user. It does not provision roles. Prefer `provisionDataPlane` for tenant isolation.

### 3. Resolve at runtime as the runtime role

```typescript
import {
  createPooledDataPlaneResolver,
  openDataPlaneConnection,
  withDataPlane,
} from "@plumbus/core";

const resolver = createPooledDataPlaneResolver<Placement>({
  describe: async (tenantRef) => placements.get(tenantRef),
  connect: ({ descriptor }) =>
    openDataPlaneConnection({
      target: {
        host: descriptor.host,
        port: descriptor.port,
        database: descriptor.database,
        user: descriptor.runtimeRole,
        password: descriptor.runtimePassword,
      },
      maxConnections: 4,
      applicationName: "my-app",
    }),
});

// Hold the plane for exactly the work that uses it:
const rows = await withDataPlane(resolver, tenantRef, async ({ db }) => db.select().from(orders));
```

`describe` returning `undefined` throws `UnknownTenantError`. The resolver never falls back to another database.

#### Leases and the connection ceiling

`cacheSize` (default 32) is the most data-plane **pools** the resolver keeps open at once, and
`cacheSize × maxConnections` is the connection budget you size the database server against. It
is a ceiling, not a target: it counts cached planes, planes still leased after an
invalidation, planes being closed and pools being opened.

A plane is held through a **lease**:

```typescript
const lease = await resolver.acquire(tenantRef);        // or withDataPlane(...) / acquireDataPlane(...)
try {
  await lease.handle.db.transaction(async (tx) => { /* ... */ });
} finally {
  lease.release();                                       // idempotent
}
```

While any lease on a plane is held the resolver never closes that plane's pool: not to make
room for another tenant, not on `invalidate`, not on a generation change (it stops handing the
plane out and closes it after the last `release()`). Only `resolver.close()` ends leased planes.

To open a plane when the ceiling is reached, the resolver closes the least recently used plane
that nobody leases. When **every** open plane is leased, the caller waits up to
`capacityWaitMs` (default 10 000 ms; `acquire(ref, { waitMs, signal })` per call) for a release
and is then refused with `DataPlaneCapacityError` (`reason: 'data-plane-capacity'`, HTTP 503 on
the request path). Nothing is closed or opened past the budget. `resolver.stats()` reports
`capacity`, `cached`, `retired`, `closing`, `connecting`, `leases` and `waiting` for health
checks and metrics.

**What the framework leases (core 0.9.0-beta.13+).** Every place the framework uses a plane
holds it for that use: each request under `requestDataPlane: 'resolved'` (released when the
response ends), each flow start, each spine claim, the whole drain of a claimed execution (its
own plane and, under `workerDataPlane: 'resolved'`, its repositories' plane), each event
delivery, each request-side flow operation (`status`, `cancel`, `resume`, wake), and the
background loops. The loops that walk `listTenantRefs` — the outbox dispatcher, the scheduler's
sync / poll / reconcile (`plumbus flow schedule sync`), the tenant dead-letter and deferred-start
sweep, and framework retention — take **one plane at a time**, use it and give it back before
taking the next, so a fleet larger than `cacheSize` is walked without closing a plane before it
is used. A tenant that fails to resolve is logged and skipped; the others are still pumped.

A capacity refusal is not a flow failure: a runner that cannot get a claimed execution's plane
hands the claim back for a later cycle.

**What `resolve()` alone gives you.** `resolve()` still works and returns the same handle, but
it takes no lease. Such a handle is protected only by recency: it can be closed under its
caller once it is the least recently used **unleased** plane and another tenant needs the slot
(statements already in flight get the connection's close timeout, 5 s for
`openDataPlaneConnection`; later statements fail with `CONNECTION_ENDED`). What changed for it:
the framework's own loops no longer cycle every tenant through the cache each second, so that
eviction is far rarer, and a `resolve()` that needs a slot while every plane is leased now waits
and is refused with `DataPlaneCapacityError` instead of closing a plane someone is using. Code
that holds a handle across awaits should use `acquire` / `withDataPlane`.

**A host resolver that wraps `createPooledDataPlaneResolver`** (for its own routing check)
must forward `acquire` as well as `resolve`, or the framework falls back to `resolve()` for
every use above and gets only the protection just described:

```typescript
export const dataPlaneResolver: DataPlaneResolver = {
  async resolve(tenantRef, options) {
    await checkRoute(tenantRef, options?.purpose);
    return pooled.resolve(tenantRef);
  },
  async acquire(tenantRef, options) {
    await checkRoute(tenantRef, options?.purpose);
    return pooled.acquire(tenantRef, options);
  },
  invalidate: (tenantRef) => pooled.invalidate(tenantRef),
};
```

`options.purpose` is `'background'` for the framework's own periodic work and `'request'` for
work done for a caller; a host may use it to choose a cheaper routing check for background
work (for example a cached route instead of a fresh read). It never changes which plane a
tenant resolves to.

### 4. Hand the resolver to the runtime from `app/server.ts`

`plumbus dev`, `plumbus start` and `plumbus worker` read the resolver family off the host's
server extensions, so a host that routes tenant data itself can also have the framework place
every flow — and, when it wants, every request — on the tenant's plane:

```ts
// app/server.ts
export const dataPlaneResolver = {
  resolve: (tenantRef, options) => router.resolve(tenantRef, options),
  acquire: (tenantRef, options) => router.acquire(tenantRef, options), // leases: see above
};
export const listTenantRefs = async () => ['tenant-a', 'tenant-b'];   // outbox + scheduler planes
export const untenantedDataPlane = 'control-plane';                   // or 'refuse' (default)
export const requestDataPlane = 'control-plane';                      // or 'resolved' (default)
export const workerDataPlane = 'control-plane';                       // or 'resolved' (default)
export const resolveTenantRef = (auth) => auth.tenantId;              // optional
```

| export | server | worker pool |
| --- | --- | --- |
| `dataPlaneResolver` | request flow engines get `spineDispatch`: a flow a request starts is written to the tenant plane the resolver names, with an opaque hint on the control plane | `WorkerPoolConfig.dataPlaneResolver`: claims from `opaque_dispatch`, runs each unit against its plane; `createDataService` is not supplied (repositories come from `entities`) |
| `requestDataPlane` | `'resolved'`: every request's repositories, events, audit and transactions are wired against the resolved plane (a `tenantScoped: false` capability still reads the control plane). `'control-plane'`: repositories stay on the boot connection; only the flows are placed | — |
| `workerDataPlane` | — | `'resolved'`: a claimed tenant unit's repositories, events and audit are wired against its plane. `'control-plane'`: they stay on the pool's database — for a host that routes tenant data itself and reaches the plane from its handlers; the unit's auth still carries the tenant, and its flow row is still on the plane |
| `untenantedDataPlane` | requests and flow starts with no tenant reference: `'refuse'` fails closed; `'control-plane'` serves them from the boot connection, and a control-plane flow is a classic `flow_executions` row on the spine, claimed beside the tenant hints | same policy for claimed work with no tenant |
| `listTenantRefs` | — | the planes whose `event_outbox` and `flow_schedules` are pumped, plus every tenant resolved for claimed work; also the tenant planes `plumbus flow schedule sync` reconciles (required by it when a flow is scheduled on `tenants`; a tenant the worker only resolved for claimed work is not reconciled) |

#### What polling every tenant costs, and how to tune it

The outbox dispatcher visits every listed plane once per `workers.outboxPollIntervalMs`
(default 1000 ms): one `acquire` (the host's routing check, with `purpose: 'background'`), three
`event_outbox` statements and, under spine dispatch, one claim transaction on
`dispatch_outbox` — whether or not the plane has work. The intervals are configuration
(core 0.9.0-beta.13+):

| setting | env | default |
| --- | --- | --- |
| `workers.outboxPollIntervalMs` | `PLUMBUS_OUTBOX_POLL_INTERVAL_MS` | 1000 |
| `workers.outboxIdleBackoffMaxMs` | `PLUMBUS_OUTBOX_IDLE_BACKOFF_MAX_MS` | 0 (off) |
| `workers.flowPollIntervalMs` | `PLUMBUS_FLOW_POLL_INTERVAL_MS` | 1000 (≥ 30 000 with durable queues) |
| `workers.schedulerPollIntervalMs` | `PLUMBUS_SCHEDULER_POLL_INTERVAL_MS` | 60000 |

With `outboxIdleBackoffMaxMs` set, a plane whose visit found nothing is skipped for twice as
long after each idle visit (starting from the poll interval) up to that cap, and is visited
every poll again as soon as a visit finds work. The cap is also the longest an event written
to an idle plane waits before it is dispatched, so choose it against your event latency
budget. The dispatcher's `wake(tenantRef?)` ends a plane's back-off early for a host that
knows it just wrote to that outbox.

Skipping planes that have no work without visiting them needs a signal outside the plane
(event outbox rows are written in the tenant's own transaction, on the tenant's database); the
framework does not have one yet.

A request-side engine that neither started nor claimed an execution locates its plane through
the spine hint (`status`, `cancel`, `resume`), so an operator capability on the control plane
can act on a tenant's execution without opening the plane itself.

How a tenant-placed execution moves: the start writes the row, its durable state and its
acceptance outbox row on the plane in one transaction, then publishes one hint on the spine
(best-effort: if publication fails the start still succeeds and the outbox pump publishes the
hint); a worker claims the hint, mints a claim token on the tenant row (the same fencing as
control-plane rows, so a stale runner cannot commit), runs the step, advances the
durable state and acknowledges the hint (closing the outbox row behind it); when the flow
has more steps the worker publishes the next hint *under its own lease* and drains the next
step without claiming again, so no second worker runs the same step — a worker that dies
mid-drain lets the lease lapse and another claims the hint. The outbox pump publishes only
rows the spine has never seen; a published hint belongs to the spine until acknowledged.
A running step's automatic/manual heartbeat extends the worker-owned spine hint and its tenant
execution row; a stale worker can extend or acknowledge neither. A retry commits
`retry-scheduled` tenant state plus a future-dated outbox row before acknowledging its current
hint, and its replacement hint cannot be claimed before `notBefore`. A hint whose row is
`waiting` for an event or a wake time is left to lapse, never run. A hint
whose tenant plane fails to resolve claim after claim (a closed or dropped tenant) is parked
as `dead-lettered` after `FlowSpineDispatchConfig.maxClaimAttempts` (default 10) claims, with
`privacy_safe_failure_category_id = 'plane-unresolved'`, instead of being re-leased forever.
The spine claim walks `opaque_dispatch_runnable_idx` and finding an execution's plane walks
`opaque_dispatch_execution_idx`; both ship in `migrations/spine/0002_claim_and_retention_indexes.sql`
(core 0.9.0-beta.5), which the spine needs applied. With `frameworkRetention` the worker pool
also prunes finished rows on the spine and on every listed plane — acknowledged hints a later
revision replaced, and a pruned execution's own hints — see
[Flows: claim indexes and retention](../core-concepts/flows.md#operations-claim-indexes-and-retention-of-finished-rows).

Three actions need more than the row on the plane, because a tenant-placed execution
only runs when the spine holds a ready hint for it:

- **Cancel.** `engine.cancel` closes the plane's durable state (`core_plumbus.execution_state`
  becomes terminal `cancelled`) as well as the row, and a claim that finds a hint for a
  terminal row — or a row already `completed`, `failed` or `cancelled` — acknowledges the hint
  instead of reviving the row.
- **Operator retry.** `retryDeadLetteredFlow(db, executionId, opts, placement)` takes an
  optional fourth argument, `{ spineDb, coreSchema? }`. With it, the reset row's durable state
  is reopened at a fresh revision and a new hint is published to the spine, so a worker claims
  the execution again; the result's `republished` says whether that happened. Without it — or
  when the plane holds no durable state for the execution (a control-plane flow, or a row
  started before placement) — the row is reset as before and claimed from its own table.
  An in-place retry is refused for a dead letter that was already retried or replayed.
  `plumbus flow dead-letter retry` (a new replay execution by default, `--in-place` for this
  reset) works on the boot database only.
- **Wake.** `ctx.flows.wake(executionId)` (core 0.9.0-beta.3+) ends a delay step early. It looks
  for the execution on the caller's own tenant plane only (resolved from `auth.tenantId`, as
  `start` places it), never on the plane a spine hint names, and treats it as tenant-placed even
  when the resolver returns the spine's own connection. In one plane transaction it moves the row's `wake_at`,
  `execution_state.wake_at`, the current revision's retry `wait_state.not_before` and that
  revision's unacknowledged `dispatch_outbox.not_before` to now; it then sets the spine hint's
  `not_before` to now (only a `ready` or `retry-scheduled` hint, never a leased one). An
  untenanted caller is refused (`untenanted-flow-wake`, recorded as `flow.wake.denied`) unless
  untenanted flows live on the control plane (`untenanted: 'control-plane'`), where it wakes only
  untenanted executions. See
  [Waking a delayed flow](../core-concepts/flows.md#waking-a-delayed-flow).

Jobs from flow steps are not plane-aware yet. A flow step that runs on a resolved tenant plane
has no job queue: `ctx.jobs.enqueue()` throws `Job queue not configured on this execution
context` and the step fails. Flow steps on the pool database (no resolver,
`workerDataPlane: 'control-plane'`, untenanted control-plane work) keep the flow job wiring.

## What this does not apply

Shipped durable-core / human-task SQL under `packages/plumbus-core/migrations/` is for dedicated harness databases only. Do not apply those files to an application tenant database. Tenant schema comes from the host app's generated `drizzle/` folder, which already includes the framework tables the generator emits.

## Factory properties (unchanged)

`openDataPlaneConnection` stays the only supported way to open a data plane:

- **Bounded.** Default pool size 5; ceiling 64. Migrate uses `maxConnections: 1`.
- **Server-side timeouts (opt-in).** `statementTimeoutMs` and `idleInTransactionTimeoutMs` (whole milliseconds, 1–2147483647; core 0.9.0-beta.5+) become the sessions' `statement_timeout` and `idle_in_transaction_session_timeout`. Unset keeps the server's settings; migrate opens its connection without them.
- **Quiet.** Passwords and connection strings never reach a message or error metadata.
- **Per-tenant.** Each call owns its pool. `close` is idempotent.
