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

  // Query multiple records, reading only the listed fields
  findManyFields?<K extends keyof T>(
    query: Partial<T> | undefined, fields: readonly K[], options?: QueryOptions,
  ): Promise<Pick<T, K>[]>;

  // Count rows matching query (tenant scoping applies like findMany)
  count(query?: Partial<T>, options?: Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'>): Promise<number>;

  // SUM / AVG / MIN / MAX / COUNT / COUNT(DISTINCT), optionally grouped — see below
  aggregate(query?: Partial<T>, options?: AggregateOptions): Promise<AggregateRow[]>;

  // Compare-and-set update: applies `updates` only if the row still matches
  // `predicate`. Optional — an adapter may not implement it. See below.
  updateWhere?(
    id: string,
    predicate: Partial<T>,
    updates: TUpdate,
  ): Promise<ConditionalUpdateResult<T>>;
}
```

After running `plumbus generate`, the `TCreate` and `TUpdate` type parameters are populated with generated input types (e.g., `UserCreateInput`, `UserUpdateInput`), giving you compile-time validation on the data passed to `create()` / `createMany()` / `update()`.

### `updateWhere(id, predicate, updates)`

A conditional (compare-and-set) write. The update lands only if the row identified by
`id` still matches every column in `predicate`; otherwise nothing is written. Use it to
make a read-then-write sequence safe against a concurrent writer without holding a
transaction open.

```typescript
interface ConditionalUpdateResult<T> {
  /** `true` only when a row matched the predicate and was updated. */
  matched: boolean;
  /** The updated row when `matched`, otherwise `null`. */
  row: T | null;
}
```

```typescript
// Claim a job only if nobody else has: status must still be 'pending'.
const claim = await ctx.data.Job.updateWhere(
  jobId,
  { status: 'pending' },
  { status: 'running', workerId },
);
if (!claim.matched) return; // someone else won the race
```

Notes:

- **It is optional on the interface.** Custom `DataService` adapters may omit it, so
  framework code that requires it probes first and fails closed — `@plumbus/chat`'s
  lease-based conversation store does exactly this and raises
  `chat.storage_unsupported` when the method is absent.
- A `null` in `predicate` matches SQL `IS NULL`, so you can condition on "not yet set".
- Tenant scoping applies exactly as it does for `update`.
- `createInMemoryRepository` in `@plumbus/core/testing` implements it with the same
  semantics, so tests exercise the real code path.

### `findMany`

`findMany(query?, options?)` returns all rows matching `query` (or all rows when omitted). Tenant scoping and access policies apply on tenant-scoped entities.

Use `findManyFields(query, fields, options?)` to fetch only the fields a read needs.
It is optional on the `Repository` type, like `updateWhere`, so custom repositories and mocks written before core 0.8.3 still compile; the framework's repositories always have it, so call it with `!`.
The repository selects these columns in SQL, before decoding rows, and infers
`Pick<T, K>[]` for the result:

```typescript
const documents = await ctx.data.Document.findManyFields!({ projectId }, ['id', 'summary'], {
  orderBy: 'createdAt',
  orderDir: 'asc',
});
// Large body fields never enter this read.
```

It takes the same `QueryOptions` as `findMany`, which keeps returning complete
records. Projection is a separate method so `findMany` stays non-generic: code that
calls `findMany` on a repository picked at runtime (`ctx.data[name]`, a union of
repository types) keeps type-checking. Empty or malformed field lists and
unknown database columns raise a validation error; they never fall back to all
fields. Duplicate fields are deduplicated. Filters, ordering and pagination may
reference unselected columns. Tenant/soft-delete predicates and encrypted-filter
guards remain unchanged; selected encrypted values are decrypted normally, and
omitted fields are not read or decrypted. Projection does not change the entity's
AI security classifications or grant any additional access.

The in-memory test repository projects after filtering, ordering and paging and
validates the selection's shape. Schema-less test repositories cannot validate
column existence; database repositories always validate against actual columns.
Custom repository implementations must implement the selection semantics before
being used for projected reads.

### `QueryOptions` (second arg to `findMany`)

`findMany(query?, options?)` accepts an optional `QueryOptions` second argument:

```typescript
interface QueryOptions {
  /** Max rows to return, honoured exactly (0 or more). Omit: every match up to the read ceiling. */
  limit?: number;
  /** Opt this read out of the read ceiling (every matching row is loaded). */
  unbounded?: boolean;
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
  /** field → allowed values (SQL IN). An empty array matches no row. */
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

### Read ceiling

One read may return at most **`data.readCeiling`** rows (`PLUMBUS_READ_CEILING`, default
**1000**) unless it passes `{ unbounded: true }`; past it the read is reported (`warn`) or refused
(`error`). The ceiling applies to `findMany`, `findManyFields`,
`findPage` and the group rows of `aggregate`; `count` and `exists` return no rows and are not
affected. A read never comes back cut short without a signal:

| The call | `readCeilingMode: 'warn'` (default) | `readCeilingMode: 'error'` |
|----------|-------------------------------------|----------------------------|
| no `limit`, at most the ceiling matches | every row | every row (`LIMIT ceiling + 1` in SQL) |
| no `limit`, more than the ceiling matches | every row, and a warning with the call site | `DataReadCeilingError`, nothing returned |
| `limit` at or under the ceiling | exactly `limit` rows | exactly `limit` rows |
| `limit` over the ceiling | exactly `limit` rows, and a warning with the call site | `DataReadCeilingError` before any query |
| `unbounded: true` | every row (or exactly `limit`) | every row (or exactly `limit`) |

Earlier releases applied no bound without a `limit` and cut any `limit` above 100 to 100
without saying so (`aggregate`: above 1000). `limit` must be a whole number of 0 or more
(`DataValidationError` otherwise); `limit: 0` returns no rows.

The warning (`Repository read went past the read ceiling; …`) goes to the server's or worker's
logger with `entity`, `operation`, `ceiling`, `cause` (`result-over-ceiling` or
`limit-over-ceiling`), `rows` or `limit`, and `stack` (the calling code's frames); one call site
is reported at most once a minute, with `repeats`. `DataReadCeilingError` is a `PlumbusError`
with code `internal` and `metadata.reason: 'read-ceiling-exceeded'`.

The policy is set per `EntityRegistry` (`registry.configureReadCeiling(createReadCeilingPolicy({
maxRows, mode, report }))`); `createServer`, the worker pool and the CLI runtimes configure it from
`config.data`. `createRepository({ readCeiling })` takes one directly; a repository built without
one uses the framework default (1000 rows, `warn`, reported with `console.warn`), not the host's
configuration — pass `readCeiling: entities.getReadCeiling()` to follow it. The in-memory test
repository applies the same policy (`createTestContext({ readCeiling })`).

When a read really needs every row of a set that can grow, walk it with `findPage`; when it
needs a number, use `count`, `exists` or `aggregate`.

### `count(query?, options?)`

Returns the number of rows matching `query` (or all rows when omitted). Tenant scoping and access policies apply identically to `findMany`. Use this in preference to `(await findMany()).length` when you only need a number — `count` issues a SQL `SELECT COUNT(*)` instead of streaming rows.

```typescript
const total = await ctx.data.User.count();
const active = await ctx.data.User.count({ status: "active" });
```

### `exists(query?, options?)`

Whether any row matches, without loading one (`SELECT 1 … LIMIT 1`). Same filters as `count`.
Optional on the `Repository` type (custom repositories written before it compile); the
framework's repositories always have it.

```typescript
if (await ctx.data.Membership.exists!({ accountId, scopeId })) { /* … */ }
```

### `findPage(query, options)` — keyset paging

One page of at most `limit` rows after the cursor of the previous page, in a total order:
the `orderBy` keys plus `id` (in the last key's direction). A deep page costs the same as the
first, and rows inserted meanwhile do not shift the pages (unlike `offset`).

```typescript
interface PageOptions extends Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'> {
  limit: number;                    // 1 .. read ceiling
  orderBy?: string | Array<{ column: string; dir?: 'asc' | 'desc' }>; // default: id asc
  orderDir?: 'asc' | 'desc';        // default 'asc'
  after?: string;                   // nextCursor of the previous page
}
interface Page<T> { rows: T[]; nextCursor: string | null }

let after: string | undefined;
do {
  const page = await ctx.data.Submission.findPage!(
    { assignmentId },
    { limit: 200, orderBy: [{ column: 'createdAt', dir: 'desc' }], ...(after ? { after } : {}) },
  );
  for (const row of page.rows) { /* … */ }
  after = page.nextCursor ?? undefined;
} while (after);
```

Sort keys must be columns of the entity, not `encrypted`, and never NULL in a row a page ends
on (`DataValidationError` otherwise). A cursor only fits the sort it came from. Add an index on
the sort keys (`indexes: [['assignmentId', 'createdAt', 'id']]`) so each page is an index range.

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
  limit?: number;      // honoured exactly; the read ceiling applies to group rows
  unbounded?: boolean; // opt out of the read ceiling
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
| `field.number()` | `INTEGER` | `integer()` |
| `field.bigint()` | `BIGINT` | `bigint({ mode: 'number' })` |
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
plumbus migrate apply --database tenant_alpha   # named tenant database
```

`--database` opens that Postgres database through `openDataPlaneConnection` (same factory as request-time data planes). Host, port, and user still come from config — use the **owner** role from `provisionDataPlane`, not the runtime role. See [Tenant data planes](./tenant-data-planes.md).

Concurrent `applyMigrations` runs against one database are serialised by a session advisory lock (`MIGRATION_ADVISORY_LOCK_KEY`) on a reserved connection: the second run waits (`MigrationConfig.onLockWait` is called once when it starts waiting), then finds nothing pending. The history hash is unique. See [CLI: concurrent runs](../cli/commands.md).

A waiting run asks for the lock again every 250 ms (`pg_try_advisory_lock`) instead of blocking in `pg_advisory_lock`: a blocked call is an open transaction, and a `CREATE INDEX CONCURRENTLY` in the running migration would wait for it while it waits for the lock — PostgreSQL would break that deadlock by aborting the index build.

Before executing, a preflight check detects if any pending migration would `CREATE TABLE` for a framework-managed table that already exists in the database. If drift is detected, the command fails with a structured error listing the conflicting tables and recovery steps. On execution failure, error messages include the migration tag, statement index, and SQL preview (`MigrationStatementError`, with the PostgreSQL error as `cause`).

### Lock timeout and retry (core 0.9.0-beta.13+)

Every migration statement runs under a PostgreSQL `lock_timeout`, five seconds by default. On a live database a DDL statement that waits for its table lock (an `ALTER TABLE` behind a long-running transaction, say) otherwise queues every later query on that table behind it for as long as it waits. With the timeout it fails instead; the runner rolls the migration back and tries it again, three more times by default with a doubling delay (1 s, 2 s, 4 s; capped at 30 s). When every attempt times out the run fails with `MigrationLockTimeoutError` (`metadata.attempts`, `metadata.lockTimeoutMs`) and the migration stays pending.

| option (`applyMigrations`, `applyDataPlaneMigrations`) | CLI (`migrate apply`) | env | default |
| --- | --- | --- | --- |
| `lockTimeoutMs` (`0` = wait forever, the old behaviour) | `--lock-timeout <ms>` | `PLUMBUS_MIGRATION_LOCK_TIMEOUT_MS` | 5000 |
| `lockRetries` | `--lock-retries <n>` | `PLUMBUS_MIGRATION_LOCK_RETRIES` | 3 |
| `lockRetryDelayMs` (first retry; doubled after) | — | — | 1000 |
| `onLockRetry(info)` | prints a line to stderr | — | — |

The setting is `SET LOCAL` inside each migration's transaction (and reset after a non-transactional migration), so it never reaches the connection pool. It bounds waits for locks only; a statement that holds its lock and takes long (an index build on a big table) is not cut short.

### Non-transactional migrations: `CREATE INDEX CONCURRENTLY`

Each migration file normally runs in one transaction. `CREATE INDEX CONCURRENTLY` cannot run in a transaction, and a plain `CREATE INDEX` blocks every write to the table until the transaction commits. A file whose leading comment block (the `--` lines before its first statement) has this line of its own runs outside a transaction:

```sql
-- plumbus:no-transaction
-- Built concurrently: ledger keeps taking writes while the index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_ref_idx ON ledger (ref);
```

Its statements (one per `--> statement-breakpoint`) run one at a time, each committed on its own, under the same lock timeout and retry — a timed-out statement is retried by itself; the ones before it are already committed. The history row is written after the last statement, so a failed run leaves the migration **pending** and the next `apply` starts it again from its first statement. Write every statement so a second run is harmless (`IF NOT EXISTS`, `IF EXISTS`), and keep one index build per file when you can.

A `CREATE INDEX CONCURRENTLY` that fails part-way leaves an **invalid** index behind (`pg_index.indisvalid = false`), and on the next run `IF NOT EXISTS` would skip it and leave it broken. The runner covers both halves:

- When a statement of a non-transactional migration fails, it drops (`DROP INDEX CONCURRENTLY`) every index that became invalid during that attempt and names them in `metadata.invalidIndexesDropped` (any it could not drop are in `metadata.invalidIndexesLeft` and in the message).
- After the last statement it records the migration only if the database holds no invalid index; otherwise it fails with `MigrationInvalidIndexError` naming them. Drop them with `DROP INDEX CONCURRENTLY` and apply again. An index another session is building at that moment also counts as invalid until it finishes.

`listInvalidIndexes(db)` returns the invalid indexes of a database for a deployment check. To turn a generated migration into one of these, edit the generated file: add the directive, make the index statement `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, and keep other DDL for the same table in a separate (transactional) file.

### Rollback

Rolls back the most recently applied migration:

```bash
plumbus migrate rollback
```

**Rollback is history-only.** It deletes the newest row from `drizzle.__drizzle_migrations` so `plumbus migrate apply` treats that migration as pending again. It does **not** execute reverse DDL — Drizzle generates no down-migrations, so tables, columns, and indexes the migration created remain in the database. Drop or restore them yourself when the schema itself has to change. The CLI prints a warning saying so, and `--json` output carries `"schemaReverted": false`.

Running against a database with no migration history (or no history table yet) reports `no_migrations` rather than failing.

### Programmatic API

```typescript
import {
  applyDataPlaneMigrations,
  applyMigrations,
  rollbackLastMigration,
} from "@plumbus/core";

const result = await applyMigrations({ db, migrationsFolder: "./drizzle" });
// result: { applied: number, tags: string[] }

// Host path: open a named tenant database as the owner, apply, always close.
const tenantResult = await applyDataPlaneMigrations({
  target: {
    host,
    port,
    database: "tenant_alpha",
    user: "tenant_alpha_owner",
    password: ownerPassword,
  },
  migrationsFolder: "./drizzle",
});
// tenantResult: { applied, tags, database?: string }

const rollback = await rollbackLastMigration({ db, migrationsFolder: "./drizzle" });
// rollback: {
//   status: 'rolled_back' | 'no_migrations',
//   rolledBack: string | null,  // tag when resolvable, else hash
//   tag: string | null,         // null when the migration file is gone
//   hash: string | null,        // sha256 recorded in the history table
// }
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
| `field.bigint()` | `number` (safe integers) |
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

