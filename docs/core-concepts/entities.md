# Entities

Entities are the **data models** of a Plumbus application. Each entity defines typed fields with classification, retention, and relation metadata.

## Defining an Entity

```typescript
import { defineEntity, field } from "@plumbus/core";

export const Customer = defineEntity({
  name: "Customer",
  description: "A customer account",
  tenantScoped: true,
  fields: {
    id: field.id(),
    name: field.string({ classification: "personal" }),
    email: field.string({ classification: "personal", maskedInLogs: true }),
    phone: field.string({ classification: "sensitive", optional: true }),
    tier: field.enum(["free", "pro", "enterprise"]),
    metadata: field.json({ optional: true }),
    isActive: field.boolean({ default: true }),
    createdAt: field.timestamp({ default: () => new Date() }),
    updatedAt: field.timestamp({ default: () => new Date() }),
  },
});
```

## Field Types

| Field Type | Function | TypeScript Type | Notes |
|-----------|---------|-----------------|-------|
| `id` | `field.id()` | `string` | Auto-generated unique identifier |
| `string` | `field.string()` | `string` | Text data |
| `number` | `field.number()` | `number` | Integer numeric data |
| `decimal` | `field.decimal()` | `number` | Decimal numeric data (mapped to a precise SQL decimal type) |
| `boolean` | `field.boolean()` | `boolean` | True/false |
| `timestamp` | `field.timestamp()` | `Date` | Date/time values |
| `json` | `field.json()` | `Record<string, unknown>` | Arbitrary JSON |
| `enum` | `field.enum(values)` | Union type | Constrained string values; pass values as the first positional argument |
| `relation` | `field.relation()` | `string` | Foreign key reference (see [Relations](#relations)) |

## Field Options

All field constructors accept the same `BaseFieldOptions`:

```typescript
field.string({
  classification: "personal",  // Data classification level
  maskedInLogs: true,          // Redact in structured logs
  optional: true,              // Allow undefined on input
  nullable: true,              // Allow null in the stored column
  required: true,              // Validation guard — input must be present
  unique: true,                // Add a UNIQUE constraint at the column level
  default: "unknown",          // Default value (literal or `() => value` factory)
  encrypted: true,             // Mark as application-layer encrypted (governance signal)
})
```

For `enum`, pass the values positionally:

```typescript
field.enum(["free", "pro", "enterprise"], { default: "free" })
```

## Data Classification

Every field that contains user data should declare a classification level:

```
┌─────────────────────────────────────────────────────────────┐
│  Classification Levels (from least to most restricted)      │
│                                                             │
│  public       → Safe to expose in APIs, logs, exports       │
│  internal     → Internal use only, not for end users        │
│  personal     → Personally identifiable information (PII)   │
│  sensitive    → Financial, health, or legal data            │
│  highly_sensitive → Passwords, tokens, encryption keys      │
└─────────────────────────────────────────────────────────────┘
```

Governance rules automatically check for:
- Missing classification on fields that contain user data
- Sensitive data exposed in API outputs
- Personal data logged without masking
- Sensitive data stored without encryption flag

## Tenant Isolation

```typescript
defineEntity({
  name: "Order",
  tenantScoped: true,  // ← Enables automatic tenant isolation
  // ...
});
```

When `tenantScoped: true`:
- All queries automatically filter by `ctx.auth.tenantId`
- Cross-tenant access is prevented at the data layer
- Governance warns if related entities have inconsistent scoping

## Relations

```typescript
defineEntity({
  name: "Order",
  fields: {
    id: field.id(),
    customerId: field.relation({ entity: "Customer", type: "many-to-one" }),
    // ...
  },
});
```

`field.relation` takes a config object with:

- `entity` (required) — name of the related entity.
- `type` (required) — one of `"one-to-one"`, `"one-to-many"`, `"many-to-one"`, `"many-to-many"`.
- `optional?: boolean` — relation is nullable.
- `classification?: FieldClassification` — propagates to the FK column.

The column on this entity holds the foreign key for `one-to-one` and `many-to-one`. Reverse-side relations (`one-to-many`, `many-to-many`) are derived for query convenience but don't add a column to this entity.

## Repository Operations

Entities get auto-generated repositories accessible via `ctx.data`:

```typescript
handler: async (ctx, input) => {
  // Create
  const user = await ctx.data.User.create({ name: "Alice", email: "alice@test.com" });

  // Read
  const found = await ctx.data.User.findById(user.id);
  const all = await ctx.data.User.findMany();                       // all rows
  const active = await ctx.data.User.findMany({ status: "active" }); // filter by field
  const byEmail = await ctx.data.User.findMany({ email: "alice@test.com" });
  const total = await ctx.data.User.count();

  // Aggregate (SUM / GROUP BY / DISTINCT in SQL — not fetch-all-then-reduce)
  const [totals] = await ctx.data.Order.aggregate(
    { status: "completed" },
    { sum: "total", count: true },
  );
  const byCustomer = await ctx.data.Order.aggregate(
    {},
    { groupBy: "customerId", sum: "total", orderBy: "sum_total", limit: 10 },
  );

  // Update
  await ctx.data.User.update(user.id, { name: "Alice Updated" });

  // Delete
  await ctx.data.User.delete(user.id);
}
```

For totals, averages, grouped rollups, or `COUNT(DISTINCT)`, use `aggregate()` instead of loading rows with `findMany` and reducing in memory. Filtering matches `findMany`/`count` (tenant scoping, soft-delete, and encrypted-field guards all apply). See [Data Layer → aggregate](../sdk-reference/data-layer.md#aggregatequery-options).

## Database Schema Generation

Entities are compiled into Drizzle ORM schemas:

```bash
# Generate migration from entity changes
plumbus migrate generate

# Apply pending migrations
plumbus migrate apply

# Rollback last migration
plumbus migrate rollback
```

## File Convention

```
app/entities/
├── customer.entity.ts
├── order.entity.ts
└── invoice-line.entity.ts
```

Entity files follow the `{kebab-name}.entity.ts` naming convention.

## Type Generation

Run `plumbus generate` to produce typed TypeScript interfaces for all your entities:

```bash
plumbus generate
```

This creates `.plumbus/generated/entity-types.ts` with:

- A **Record interface** per entity (e.g. `UserRecord`) mapping fields to TypeScript types
- A **CreateInput interface** per entity (e.g. `UserCreateInput`) that omits system fields (`id`, `createdAt`, `updatedAt`, `tenantId`)
- An **UpdateInput interface** per entity (e.g. `UserUpdateInput`) with all non-system fields optional
- A `DataServiceMap` interface mapping entity names to `Repository<T, TCreate, TUpdate>` for typed `ctx.data` access

After generation, calls like `ctx.data.User.create({ ... })` and `ctx.data.User.update(id, { ... })` are type-checked against the entity's fields.

See [Data Layer → Entity Type Generation](../sdk-reference/data-layer.md#entity-type-generation) for details.

---

## SDK reference

For every `defineEntity` option — `domain`, `tags`, `owner`, `indexes`, `retention`, the full `BaseFieldOptions` shape, every field constructor — see [SDK Reference → defineEntity](../sdk-reference/define-functions.md#defineentity) and [SDK Reference → Data Layer](../sdk-reference/data-layer.md). This page covers the common case; the reference is exhaustive.

