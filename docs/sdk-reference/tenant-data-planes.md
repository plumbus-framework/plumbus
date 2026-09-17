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

`applyDataPlaneMigrations` is a thin compose of `openDataPlaneConnection` (the existing factory) and `applyMigrations`. It always closes the pool, including when apply fails. Credentials never appear in factory errors.

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

const { db } = await resolver.resolve(tenantRef);
```

`describe` returning `undefined` throws `UnknownTenantError`. The resolver never falls back to another database.

### 4. Hand the resolver to the runtime from `app/server.ts`

`plumbus dev`, `plumbus start` and `plumbus worker` read the resolver family off the host's
server extensions, so a host that routes tenant data itself can also have the framework place
every flow — and, when it wants, every request — on the tenant's plane:

```ts
// app/server.ts
export const dataPlaneResolver = { resolve: (tenantRef) => router.resolve(tenantRef) };
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
| `listTenantRefs` | — | the planes whose `event_outbox` and `flow_schedules` are pumped, plus every tenant resolved for claimed work |

A request-side engine that neither started nor claimed an execution locates its plane through
the spine hint (`status`, `cancel`, `resume`), so an operator capability on the control plane
can act on a tenant's execution without opening the plane itself.

How a tenant-placed execution moves: the start writes the row and its durable state on the
plane and one hint on the spine; a worker claims the hint, runs the step, advances the
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

Two operator actions need more than the row on the plane, because a tenant-placed execution
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

## What this does not apply

Shipped durable-core / human-task SQL under `packages/plumbus-core/migrations/` is for dedicated harness databases only. Do not apply those files to an application tenant database. Tenant schema comes from the host app's generated `drizzle/` folder, which already includes the framework tables the generator emits.

## Factory properties (unchanged)

`openDataPlaneConnection` stays the only supported way to open a data plane:

- **Bounded.** Default pool size 5; ceiling 64. Migrate uses `maxConnections: 1`.
- **Quiet.** Passwords and connection strings never reach a message or error metadata.
- **Per-tenant.** Each call owns its pool. `close` is idempotent.
