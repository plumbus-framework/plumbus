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

## What this does not apply

Shipped durable-core / human-task SQL under `packages/plumbus-core/migrations/` is for dedicated harness databases only. Do not apply those files to an application tenant database. Tenant schema comes from the host app's generated `drizzle/` folder, which already includes the framework tables the generator emits.

## Factory properties (unchanged)

`openDataPlaneConnection` stays the only supported way to open a data plane:

- **Bounded.** Default pool size 5; ceiling 64. Migrate uses `maxConnections: 1`.
- **Quiet.** Passwords and connection strings never reach a message or error metadata.
- **Per-tenant.** Each call owns its pool. `close` is idempotent.
