# Data Layer Reference

The Plumbus data layer handles database schema generation, migrations, repositories, and tenant isolation — all derived from entity definitions.

## Architecture

```
Entity Definitions
       │
       ▼
┌──────────────────┐
│ Schema Generator │ ← generateDrizzleSchema()
│                  │
│ EntityDefinition │
│ → Drizzle Table  │
└────────┬─────────┘
         │
┌────────▼─────────┐     ┌──────────────┐
│ EntityRegistry   │────▶│ DataService  │
│                  │     │              │
│ register(entity) │     │ ctx.data.User│
│ createDataService│     │ ctx.data.Ord.│
└────────┬─────────┘     └──────────────┘
         │
┌────────▼─────────┐
│ Migrations       │
│                  │
│ generate → apply │
│ → rollback       │
└──────────────────┘
```

## EntityRegistry

Central registry that manages all entities and their database tables:

```typescript
import { EntityRegistry } from "@plumbus/core";

const registry = new EntityRegistry();

// Register entities
registry.register(UserEntity);
registry.register(OrderEntity);
registry.registerAll([InvoiceEntity, PaymentEntity]);

// Look up
const entity = registry.getEntity("User");
const table = registry.getTable("User");

// List all
const allEntities = registry.getAllEntities();
const allTables = registry.getAllTables();

// Create data service for execution context
const dataService = registry.createDataService({
  db: drizzleInstance,
  auth: authContext,
  audit: auditService,
});
```

### `bypassTenantScope`

`createDataService({ db, auth, audit, bypassTenantScope })` accepts an optional `bypassTenantScope: boolean`. When `true`, the resulting data service skips the automatic `WHERE tenant_id = $auth.tenantId` predicate on every query. Reserved for two narrow use cases:

1. Internal administrative endpoints that legitimately need cross-tenant access.
2. MCP and HTTP routes serving a capability with `access.tenantScoped: false` (the route generator sets this automatically — see [MCP transports](../mcp/transports.md) and [route generator](../security/security-model.md)).

Setting `bypassTenantScope: true` from application code is a security-sensitive escape hatch — do not enable it unless you have explicitly designed for cross-tenant reads. Tenant-scoped capabilities (the default) must NEVER use `bypassTenantScope: true`.

## createRepository

Creates a repository for a single entity with built-in tenant isolation and audit:

```typescript
import { createRepository } from "@plumbus/core";

const userRepo = createRepository<User>({
  entity: UserEntity,
  table: usersTable,
  db: drizzleInstance,
  auth: authContext,
  audit: auditService,
  softDelete: true,
  bypassTenantScope: false, // Set true for cross-tenant admin access
  encryptionKey: resolveEncryptionKey(), // optional — from PLUMBUS_ENCRYPTION_KEY
});
```

### Field encryption

String fields with `encrypted: true` are encrypted with AES-256-GCM before insert/update when `PLUMBUS_ENCRYPTION_KEY` is set. Reads decrypt values prefixed with `plumbus:enc:v1:`; legacy plaintext rows pass through unchanged. When the key is set, repositories also reject `findMany`/`aggregate` filters and aggregate functions (`sum`, `avg`, `min`, `max`, `countDistinct`, `groupBy`) on encrypted string columns — see [aggregate → encrypted fields](#aggregatequery-options).

```typescript
import { getEncryptedFields, resolveEncryptionKey } from "@plumbus/core";

const key = resolveEncryptionKey();
const encryptedFieldNames = getEncryptedFields(UserEntity);
```

### Log masking helpers

```typescript
import { getMaskedFields, collectMaskedFieldsFromEntities } from "@plumbus/core";

const masked = getMaskedFields(UserEntity);
const allMasked = collectMaskedFieldsFromEntities(registry.getAllEntities());
```

Audit logs mask sensitive fields automatically. Structured capability loggers use the same field names via `maskKeys` (see [Observability](observability.md)).

### Repository Methods

```typescript
interface Repository<
  T = Record<string, any>,
  TCreate = Record<string, any>,
  TUpdate = Record<string, any>,
> {
  // Find by primary key
  findById(id: string): Promise<T | null>;

  // Create a new record
  create(data: TCreate): Promise<T>;

  // Bulk-create N records in a single DB round-trip plus one summary audit row.
  // Empty arrays short-circuit to []. Use for hot paths that would otherwise
  // call create() in a loop (typically > ~10 records).
  createMany(records: TCreate[]): Promise<T[]>;

  // Update by ID
  update(id: string, updates: TUpdate): Promise<T>;

  // Delete by ID (soft or hard based on config)
  delete(id: string): Promise<void>;

  // Query multiple records
  findMany(query?: Partial<T>, options?: QueryOptions): Promise<T[]>;

  // Count rows matching query (tenant scoping applies like findMany)
  count(query?: Partial<T>, options?: Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'>): Promise<number>;

  // SUM / AVG / MIN / MAX / COUNT / COUNT(DISTINCT), optionally grouped — see below
  aggregate(query?: Partial<T>, options?: AggregateOptions): Promise<AggregateRow[]>;
}
```

After running `plumbus generate`, the `TCreate` and `TUpdate` type parameters are populated with generated input types (e.g., `UserCreateInput`, `UserUpdateInput`), giving you compile-time validation on the data passed to `create()` / `createMany()` / `update()`.

### `findMany`

`findMany(query?, options?)` returns all rows matching `query` (or all rows when omitted). Tenant scoping and access policies apply on tenant-scoped entities.

### `QueryOptions` (second arg to `findMany`)

`findMany(query?, options?)` accepts an optional `QueryOptions` second argument:

```typescript
interface QueryOptions {
  /** Max rows to return (1–100). Omit for no limit. */
  limit?: number;
  /** Number of rows to skip (default 0) */
  offset?: number;
  /** Column name or multi-column sort spec — validated against entity table columns */
  orderBy?: string | Array<{ column: string; dir?: 'asc' | 'desc' }>;
  /** Default sort direction (default 'desc') — applied to a string `orderBy`, and the fallback for array specs that omit `dir` */
  orderDir?: 'asc' | 'desc';
  /** Date range filters: { columnName: { gte?: Date, lte?: Date } } */
  dateFilters?: Record<string, { gte?: Date; lte?: Date }>;
  /** OR-of-ILIKE across the given entity fields for a free-text term */
  search?: { columns: string[]; term: string };
  /** field → allowed values (SQL IN). Empty arrays ignored */
  in?: Record<string, Array<string | number>>;
  /** field → value the row must NOT equal (SQL <>) */
  notEq?: Record<string, string | number>;
}
```

```typescript
const matches = await ctx.data.User.findMany(
  { status: "active" },
  {
    search: { columns: ["name", "email"], term: "alice" },
    in: { role: ["admin", "user"] },
    notEq: { status: "deleted" },
    orderBy: [{ column: "createdAt", dir: "desc" }],
    limit: 20,
  },
);
```

### `count(query?, options?)`

Returns the number of rows matching `query` (or all rows when omitted). Tenant scoping and access policies apply identically to `findMany`. Use this in preference to `(await findMany()).length` when you only need a number — `count` issues a SQL `SELECT COUNT(*)` instead of streaming rows.

```typescript
const total = await ctx.data.User.count();
const active = await ctx.data.User.count({ status: "active" });
```

### `aggregate(query?, options?)`

Compute `SUM` / `AVG` / `MIN` / `MAX` / `COUNT` / `COUNT(DISTINCT)` in the database, optionally with `GROUP BY`, instead of loading rows to reduce in memory. Filtering reuses the exact `findMany`/`count` semantics — the `query` equality argument plus `dateFilters`/`search`/`in`/`notEq` — and tenant scoping, soft-delete, and encrypted-field guards all apply unchanged.

Without `groupBy`, returns exactly one grand-total row (even over zero matches, where `SUM` is `0`). With `groupBy`, returns one row per group that has matching records.

```typescript
type AggregateValue = string | number | boolean | Date | null;
type AggregateRow = Record<string, AggregateValue>;

interface AggregateOptions
  extends Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'> {
  groupBy?: string | string[];
  sum?: string | string[];
  avg?: string | string[];
  min?: string | string[];
  max?: string | string[];
  count?: boolean;
  countDistinct?: string | string[];
  orderBy?: string | Array<{ column: string; dir?: 'asc' | 'desc' }>;
  orderDir?: 'asc' | 'desc';
  limit?: number; // clamped to 1–1000
}
```

Result rows key each `groupBy` column by its value, plus:

| Option | Result key | Type notes |
|--------|------------|------------|
| `count: true` | `count` | number |
| `sum: 'cost'` | `sum_cost` | number; empty set = `0` |
| `avg: 'cost'` | `avg_cost` | number or `null` over empty set |
| `min` / `max` | `min_<col>` / `max_<col>` | mirrors column type, or `null` over empty set |
| `countDistinct: 'provider'` | `countDistinct_provider` | number |

```typescript
// Grand total over a filtered scope — one row, even over zero matches:
const [totals] = await ctx.data.ProjectCostLedger.aggregate(
  { projectId },
  { dateFilters: { recordedAt: { gte: monthStart } }, sum: "cost", count: true },
);
totals.sum_cost; // number (empty scope = 0); totals.count // number

// GROUP BY with per-group aggregates, ordered by an aggregate, limited:
const byProvider = await ctx.data.ProjectCostLedger.aggregate(
  {},
  { groupBy: "provider", sum: "cost", count: true, orderBy: "sum_cost", orderDir: "desc", limit: 10 },
);
// → [{ provider: "openai", sum_cost: 41.2, count: 318 }, ...]

// COUNT(DISTINCT), min/max/avg also supported:
await ctx.data.WorkflowStep.aggregate({}, { countDistinct: "projectId" });
// → [{ countDistinct_projectId: 7 }]
```

`orderBy` may reference a group column or an aggregate alias (e.g. `"sum_cost"`); unknown names are ignored. Requesting neither a group column nor an aggregate function throws. Aggregating an `encrypted: true` field is rejected. Add a matching composite index (e.g. `indexes: [["projectId", "recordedAt"]]`) so grouped aggregates run as index scans.

The in-memory test repository (`createTestContext` / `createInMemoryRepository`) mirrors these semantics, so `aggregate()` is unit-testable without a database.

### Automatic Tenant Isolation

When an entity has `tenantScoped: true`, the repository automatically:

```
findMany() called
       │
       ▼
┌──────────────────┐
│ Check entity     │
│ tenantScoped?    │
└──────┬───────────┘
       │ yes
       ▼
┌──────────────────┐
│ Inject WHERE     │
│ tenant_id =      │
│ ctx.auth.tenantId│
└──────┬───────────┘
       │
       ▼
   Execute query
```

Cross-tenant access is prevented at the data layer — no capability can accidentally read another tenant's data.

## Drizzle query helpers

`@plumbus/core` re-exports common Drizzle operators for custom queries against `collectSchemas()` tables:

```typescript
import { and, gte, ilike } from "drizzle-orm";

await db
  .select()
  .from(schemas.orders)
  .where(and(gte(schemas.orders.createdAt, since), ilike(schemas.orders.notes, "%urgent%")));
```

`@plumbus/core` re-exports `gte`, `lte`, `like`, `ilike`, and `sql` for simple filters. For compound `where` clauses, import `and` / `or` / `ne` from `drizzle-orm` (already a transitive dependency of `@plumbus/core`).

Use these for ad hoc reporting or admin queries — routine entity access should go through `ctx.data` repositories.

## Schema Generation

Converts entity definitions into Drizzle ORM schemas:

```typescript
import { generateDrizzleSchema, generateSchemas } from "@plumbus/core";

// Single entity
const usersTable = generateDrizzleSchema(UserEntity);

// All entities
const tableMap = generateSchemas([UserEntity, OrderEntity, InvoiceEntity]);
```

### Field Type Mapping

| Plumbus Field | PostgreSQL Column | Drizzle Type |
|--------------|-------------------|-------------|
| `field.id()` | `TEXT PRIMARY KEY` | `text().primaryKey()` |
| `field.string()` | `TEXT` | `text()` |
| `field.number()` | `DOUBLE PRECISION` | `doublePrecision()` |
| `field.decimal()` | `DOUBLE PRECISION` | `doublePrecision()` |
| `field.boolean()` | `BOOLEAN` | `boolean()` |
| `field.timestamp()` | `TIMESTAMP` | `timestamp()` |
| `field.json()` | `JSONB` | `jsonb()` |
| `field.enum([...])` | `TEXT` | `text()` |
| `field.relation(...)` | `TEXT REFERENCES ...` | `text()` |

Tenant-scoped entities automatically receive a `tenant_id TEXT NOT NULL` column.

## Migrations

### Generate

Compares current entity definitions against database state and generates SQL migrations:

```bash
plumbus migrate generate
```

Produces timestamped migration files in `migrations/`.

### Apply

Applies all pending migrations in order:

```bash
plumbus migrate apply
```

Before executing, a preflight check detects if any pending migration would `CREATE TABLE` for a framework-managed table that already exists in the database. If drift is detected, the command fails with a structured error listing the conflicting tables and recovery steps. On execution failure, error messages include the migration tag, statement index, and SQL preview.

### Rollback

Rolls back the most recently applied migration:

```bash
plumbus migrate rollback
```

### Programmatic API

```typescript
import { applyMigrations, rollbackLastMigration } from "@plumbus/core";

const result = await applyMigrations({ db, migrationsFolder: "./drizzle" });
// result: { applied: number, tags: string[] }

await rollbackLastMigration({ db, migrationsFolder: "./drizzle" });
```

## collectSchemas

Collects all generated Drizzle schemas for use in ORM configuration. This includes both user-defined entity tables and all framework-internal tables (audit, event outbox, flow execution, RAG):

```typescript
import { collectSchemas } from "@plumbus/core";

const schemas = collectSchemas(entityRegistry);
// Includes: entity tables + audit_records, event_outbox, event_idempotency,
// event_dead_letter, flow_executions, flow_dead_letter, flow_schedules,
// documents, document_chunks
```

## Event Tables

The data layer also includes framework tables for the event/flow systems:

```typescript
import {
  outboxTable,          // Event outbox
  deadLetterTable,      // Failed events
  idempotencyTable,     // Event deduplication
  flowExecutionsTable,  // Flow state
  flowSchedulesTable,   // Cron schedules
  flowDeadLetterTable,  // Failed flows
  documentsTable,       // RAG documents
  documentChunksTable,  // RAG chunks
} from "@plumbus/core";
```

These tables are created automatically with `plumbus migrate apply`. **Do not create them manually** — the framework manages their lifecycle through generated migrations. Both `migrate apply` and `migrate push` include preflight drift detection that will fail fast if these tables are found with unexpected structure.

## Entity Type Generation

Running `plumbus generate` produces typed interfaces for all your entities, giving you compile-time type safety when accessing `ctx.data`:

```bash
plumbus generate
```

This creates `.plumbus/generated/entity-types.ts` containing:

1. **Record interfaces** — one per entity, mapping field names to TypeScript types
2. **Create/Update input types** — `{Name}CreateInput` (omits system fields) and `{Name}UpdateInput` (all fields optional) per entity
3. **`DataServiceMap`** — maps entity names to typed `Repository<T, TCreate, TUpdate>` instances

### Example Output

Given this entity definition:

```typescript
export const User = defineEntity({
  name: "User",
  fields: {
    id: field.id(),
    email: field.string({ required: true, unique: true }),
    name: field.string(),
    role: field.enum(["admin", "user"]),
    isActive: field.boolean(),
  },
  tenantScoped: true,
});
```

The generated file will contain:

```typescript
// Auto-generated by `plumbus generate` — do not edit

import type { Repository } from "@plumbus/core";

export interface UserRecord {
  id: string;
  email: string;
  name?: string;
  role?: "admin" | "user";
  isActive?: boolean;
  createdAt: Date;
  updatedAt: Date;
  tenantId: string;
}

export interface UserCreateInput {
  email: string;
  name?: string;
  role?: "admin" | "user";
  isActive?: boolean;
}

export interface UserUpdateInput {
  email?: string;
  name?: string;
  role?: "admin" | "user";
  isActive?: boolean;
}

export interface DataServiceMap {
  User: Repository<UserRecord, UserCreateInput, UserUpdateInput>;
}
```

### Field Type Mapping (TypeScript)

| Plumbus Field | TypeScript Type |
|--------------|----------------|
| `field.id()` | `string` |
| `field.string()` | `string` |
| `field.number()` | `number` |
| `field.decimal()` | `number` |
| `field.boolean()` | `boolean` |
| `field.timestamp()` | `Date` |
| `field.json()` | `unknown` |
| `field.enum([...])` | Union of string literals |
| `field.relation(...)` | `string` |

### Auto-Added Fields

The generator mirrors the schema generator's behavior — these fields are automatically included in generated interfaces when not explicitly defined:

- `createdAt: Date` — always added
- `updatedAt: Date` — always added
- `tenantId: string` — added for `tenantScoped: true` entities

### PlumbusRegistry Type Augmentation

In addition to the standalone type files, `plumbus generate` produces a `.plumbus/generated/plumbus.d.ts` file that augments the `PlumbusRegistry` interface from `@plumbus/core`. This provides strict type safety for `ctx.data` (and other framework types) without any manual wiring:

```typescript
// Auto-generated by `plumbus generate` — do not edit
import type { Repository } from "@plumbus/core";
import type { UserRecord, UserCreateInput, UserUpdateInput } from "./entity-types.js";

declare module "@plumbus/core" {
  interface PlumbusRegistry {
    capabilityName: "getUser" | "createOrder";
    eventName: "user.created" | "order.completed";
    eventPayloads: {
      "user.created": { userId: string };
      "order.completed": { orderId: string; total: number };
    };
    flowName: "onboardUser";
    entities: {
      User: Repository<UserRecord, UserCreateInput, UserUpdateInput>;
    };
  }
}
```

The `plumbus generate` command automatically adds `.plumbus/generated` to your `tsconfig.json` `include` array, so this file is picked up by TypeScript. Once active, `ctx.data` only exposes entity names you've actually defined. Before generation, all types fall back to permissive defaults (`string` / `Record<string, Repository>`) for backward compatibility.

