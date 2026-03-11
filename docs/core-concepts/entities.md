# Entities

Entities are the **data models** of a Plumbus application. Each entity defines typed fields with classification, retention, and relation metadata.

## Defining an Entity

```typescript
import { defineEntity, field } from "plumbus-core";

export const Customer = defineEntity({
  name: "Customer",
  description: "A customer account",
  tenantScoped: true,
  fields: {
    id: field.id(),
    name: field.string({ classification: "personal" }),
    email: field.string({ classification: "personal", maskedInLogs: true }),
    phone: field.string({ classification: "sensitive", optional: true }),
    tier: field.enum({ values: ["free", "pro", "enterprise"] }),
    metadata: field.json({ optional: true }),
    isActive: field.boolean({ default: true }),
    createdAt: field.timestamp({ defaultNow: true }),
    updatedAt: field.timestamp({ defaultNow: true }),
  },
});
```

## Field Types

| Field Type | Function | TypeScript Type | Notes |
|-----------|---------|-----------------|-------|
| `id` | `field.id()` | `string` | Auto-generated unique identifier |
| `string` | `field.string()` | `string` | Text data |
| `number` | `field.number()` | `number` | Numeric data |
| `boolean` | `field.boolean()` | `boolean` | True/false |
| `timestamp` | `field.timestamp()` | `Date` | Date/time values |
| `json` | `field.json()` | `Record<string, unknown>` | Arbitrary JSON |
| `enum` | `field.enum()` | Union type | Constrained string values |
| `relation` | `field.relation()` | `string` | Foreign key reference |

## Field Options

```typescript
field.string({
  classification: "personal",  // Data classification level
  maskedInLogs: true,          // Redact in structured logs
  optional: true,              // Nullable field
  default: "unknown",          // Default value
})
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
    customerId: field.relation({ entity: "Customer", kind: "belongsTo" }),
    // ...
  },
});
```

Relation kinds:
- `belongsTo` — this entity holds the foreign key
- `hasMany` — reverse of belongsTo
- `hasOne` — unique reverse relation

## Repository Operations

Entities get auto-generated repositories accessible via `ctx.data`:

```typescript
handler: async (ctx, input) => {
  // Create
  const user = await ctx.data.User.create({ name: "Alice", email: "alice@test.com" });

  // Read
  const found = await ctx.data.User.findById(user.id);
  const all = await ctx.data.User.findMany();
  const byEmail = await ctx.data.User.findByEmail("alice@test.com");

  // Update
  await ctx.data.User.update(user.id, { name: "Alice Updated" });

  // Delete
  await ctx.data.User.delete(user.id);
}
```

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

