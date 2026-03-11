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
import { EntityRegistry } from "plumbus-core";

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
import { createRepository } from "plumbus-core";

const userRepo = createRepository<User>({
  entity: UserEntity,
  table: usersTable,
  db: drizzleInstance,
  auth: authContext,
  audit: auditService,
  softDelete: true,
});
```

### Repository Methods

```typescript
interface Repository<T> {
  // Find by primary key
  findById(id: string): Promise<T | null>;

  // Create a new record
  create(data: Partial<T>): Promise<T>;

  // Update by ID
  update(id: string, updates: Partial<T>): Promise<T>;

  // Delete by ID (soft or hard based on config)
  delete(id: string): Promise<void>;

  // Query multiple records
  findMany(query?: Record<string, unknown>): Promise<T[]>;
}
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
import { generateDrizzleSchema, generateSchemas } from "plumbus-core";

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

### Rollback

Rolls back the most recently applied migration:

```bash
plumbus migrate rollback
```

### Programmatic API

```typescript
import { applyMigrations, rollbackLastMigration } from "plumbus-core";

await applyMigrations({ db, migrationsDir: "./migrations" });
await rollbackLastMigration({ db, migrationsDir: "./migrations" });
```

## collectSchemas

Collects all generated Drizzle schemas for use in ORM configuration:

```typescript
import { collectSchemas } from "plumbus-core";

const schemas = collectSchemas(entityRegistry);
// Use in Drizzle config
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
} from "plumbus-core";
```

These tables are created automatically with `plumbus migrate apply`.

