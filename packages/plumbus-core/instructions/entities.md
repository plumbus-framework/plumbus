# Entities

An entity is a data model definition with field classifications, relations, and retention policies.

## Defining an Entity

```ts
import { defineEntity, field } from "@plumbus/core";

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

### Pagination & search

For paginated list capabilities, push pagination + search to SQL with `findMany` + `count` (never fetch-all-then-slice):

```ts
const filters = {
  search: { columns: ["displayName", "email"], term: input.search },
  in: { role: ["staff", "admin"] },
  notEq: { status: "archived" },
};
const items = await ctx.data.User.findMany(
  { active: true },
  { ...filters, orderBy: "createdAt", orderDir: "desc", limit: input.limit, offset: (input.page - 1) * input.limit },
);
const total = await ctx.data.User.count({ active: true }, filters);
```

`findMany` applies `limit`/`offset`/`orderBy`; `count` returns the matching row count over the same filters (so page totals stay correct). `search` uses case-insensitive `ILIKE` (OR across columns), `in` is SQL `IN`, `notEq` is `<>`. Multi-column sort: `orderBy: [{ column: "name", dir: "asc" }, { column: "createdAt", dir: "desc" }]`. Tenant isolation and soft-delete filters are applied automatically.

### Aggregates (SUM / GROUP BY / DISTINCT)

To total, average, or group **in the database** — instead of loading rows and reducing in memory — use `aggregate`. Filtering is identical to `findMany`/`count` (the `query` equality arg plus `dateFilters`/`search`/`in`/`notEq`), and tenant scoping, soft-delete, and encrypted-field guards all apply.

```ts
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
await ctx.data.WorkflowStep.aggregate({}, { countDistinct: "projectId" }); // [{ countDistinct_projectId: 7 }]
```

Result rows (`AggregateRow`) key each `groupBy` column by its value, plus `count` (when `count: true`), `sum_<col>`, `avg_<col>`, `min_<col>`, `max_<col>`, and `countDistinct_<col>` per requested column. `sum_*`, `count`, and `countDistinct_*` are numbers (an empty `SUM` is `0`, not `null`); `avg_*`/`min_*`/`max_*` are `null` over an empty set. Without `groupBy` you always get exactly one grand-total row; with `groupBy`, one row per group that has matching records. `orderBy` may reference a group column or an aggregate alias (e.g. `"sum_cost"`); `limit` is clamped to 1–1000. Requesting neither a group column nor an aggregate throws. Aggregating an `encrypted: true` field is rejected. Add a matching composite index (e.g. `indexes: [["projectId", "recordedAt"]]`) so the aggregate runs as an index scan.

Repositories automatically:
- Inject `tenantId` from `ctx.auth.tenantId` (if `tenantScoped: true`)
- Record audit events for mutations
- Mask sensitive fields in logs
