# Entities

An entity is a data model definition with field classifications, relations, and retention policies.

## Defining an Entity

```ts
import { defineEntity, field } from "plumbus-core";

export const User = defineEntity({
  name: "User",
  domain: "identity",
  tenantScoped: true,

  fields: {
    id: field.id(),
    email: field.string({ required: true, unique: true, classification: "personal" }),
    name: field.string({ required: true }),
    passwordHash: field.string({ required: true, classification: "highly_sensitive", maskedInLogs: true }),
    role: field.enum(["admin", "user", "viewer"], { required: true, default: "user" }),
    organizationId: field.relation({ entity: "Organization", type: "many-to-one" }),
    lastLoginAt: field.timestamp({ nullable: true }),
    metadata: field.json({ classification: "internal" }),
    active: field.boolean({ default: true }),
  },

  indexes: [["email"], ["organizationId", "active"]],
  retention: { duration: "365d" },
});
```

## Field Types

| Constructor | Stored As | Notes |
|-------------|-----------|-------|
| `field.id()` | UUID string | Primary key |
| `field.string(opts)` | Text | General text |
| `field.number(opts)` | Numeric | Integer or decimal |
| `field.boolean(opts)` | Boolean | |
| `field.timestamp(opts)` | Datetime | ISO timestamps |
| `field.json(opts)` | JSONB | Arbitrary structured data |
| `field.enum(values, opts)` | Text | Constrained to provided values |
| `field.relation(config)` | Foreign key | Links to another entity |

## Field Options

All field types accept these options:

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `required` | boolean | false | Field must have a value |
| `default` | any | — | Default value if not provided |
| `unique` | boolean | false | Unique constraint |
| `nullable` | boolean | false | Allow null |
| `classification` | FieldClassification | — | Data sensitivity level |
| `encrypted` | boolean | false | Encrypt at rest |
| `maskedInLogs` | boolean | false | Mask in audit/log output |

## Classification Levels

| Level | Meaning | Example |
|-------|---------|---------|
| `public` | No restrictions | Product name |
| `internal` | Internal use only | Internal notes |
| `personal` | Personally identifiable | Email, name |
| `sensitive` | Requires protection | Phone, address |
| `highly_sensitive` | Maximum protection | SSN, password hash |

Classifications drive: log masking, audit field tracking, governance warnings, and encryption requirements.

## Relations

```ts
field.relation({ entity: "Organization", type: "many-to-one" })
```

Relation types: `one-to-one`, `one-to-many`, `many-to-one`, `many-to-many`.

## Repository (generated)

Each entity gets a typed repository on `ctx.data`:

```ts
const user = await ctx.data.User.findById("usr_123");
const users = await ctx.data.User.findMany({ active: true });
const created = await ctx.data.User.create({ email: "a@b.com", name: "Alice" });
await ctx.data.User.update("usr_123", { active: false });
await ctx.data.User.delete("usr_123");
```

Repositories automatically:
- Inject `tenantId` from `ctx.auth.tenantId` (if `tenantScoped: true`)
- Record audit events for mutations
- Mask sensitive fields in logs
