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
});
```

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
  findMany(query?: Partial<T>): Promise<T[]>;
}
```

After running `plumbus generate`, the `TCreate` and `TUpdate` type parameters are populated with generated input types (e.g., `UserCreateInput`, `UserUpdateInput`), giving you compile-time validation on the data passed to `create()` / `createMany()` / `update()`.
```

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

