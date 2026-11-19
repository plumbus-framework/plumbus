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
| `field.number(opts)` | 32-bit integer | Counts and small integers |
| `field.bigint(opts)` | 64-bit integer | Money in minor units (cents) and totals; JS number, safe integers only (core 0.7.7+) |
| `field.decimal(opts)` | Floating point | Measurements; never money |
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
// input: z.object({ page: z.number().int().min(1), limit: z.number().int().min(1).max(100), search: z.string() })
// Bound `limit` in the schema: the repository honours it exactly.
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

**Every read has a ceiling.** One read may return at most the host's read ceiling (`data.readCeiling`, default 1000 rows) unless it passes `{ unbounded: true }`. `limit` is honoured exactly (no hidden cap at 100). An unlimited read that matches more rows than the ceiling, or a `limit` above it, is returned in full and logged with its call site (`readCeilingMode: 'warn'`, the default) or refused with `DataReadCeilingError` (`'error'`) — it is never cut short. In `warn` mode nothing caps a `limit`, so bound a caller-supplied page size in the input schema (`z.number().int().min(1).max(100)`). So:

- Need a number? `count`, `exists!` (`SELECT 1 … LIMIT 1`) or `aggregate` — never `(await findMany()).length` or a sum in JS.
- Need one row? Filter on the key and pass `limit: 1`, or `findById`.
- Need to walk a set that can grow (all seats of a course, all rows of a tenant)? Keyset paging with `findPage!(query, { limit, orderBy, after })`, which returns `{ rows, nextCursor }`; loop until `nextCursor` is `null`. See [data-layer](../../../docs/sdk-reference/data-layer.md#findpagequery-options--keyset-paging).
- Really need every row, and the set is known to stay small? `{ unbounded: true }` — greppable on purpose.

`in: { field: [] }` (an empty list) matches **no** rows. To make an `in` filter optional, leave the key out when there is nothing to filter by: `...(ids.length ? { in: { id: ids } } : {})`.

### Reading only some fields (core 0.8.3+)

When a read needs a few columns of rows that also hold large fields (document bodies, transcripts), use `findManyFields(query, fields, options?)`. It selects only those columns in SQL and returns `Pick<T, K>[]`:

```ts
const docs = await ctx.data.Document.findManyFields!({ projectId }, ['id', 'summary'], { orderBy: 'createdAt' });
```

It takes the same options as `findMany` and keeps tenant scoping, soft-delete filters and decryption of selected encrypted fields. Empty, malformed or unknown field lists throw. `findMany` is unchanged and still returns complete records. It is optional on the `Repository` type, like `updateWhere`, so custom repositories and mocks written before core 0.8.3 still compile; the framework's repositories always have it, so call it with `!`.

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

Result rows (`AggregateRow`) key each `groupBy` column by its value, plus `count` (when `count: true`), `sum_<col>`, `avg_<col>`, `min_<col>`, `max_<col>`, and `countDistinct_<col>` per requested column. `sum_*`, `count`, and `countDistinct_*` are numbers (an empty `SUM` is `0`, not `null`); `avg_*`/`min_*`/`max_*` are `null` over an empty set. Without `groupBy` you always get exactly one grand-total row; with `groupBy`, one row per group that has matching records. `orderBy` may reference a group column or an aggregate alias (e.g. `"sum_cost"`); `limit` is honoured exactly and the read ceiling applies to group rows as to `findMany` rows. Requesting neither a group column nor an aggregate throws. Aggregating an `encrypted: true` field is rejected. Add a matching composite index (e.g. `indexes: [["projectId", "recordedAt"]]`) so the aggregate runs as an index scan.

Repositories automatically:
- Inject `tenantId` from `ctx.auth.tenantId` (if `tenantScoped: true`)
- Record audit events for mutations
- Mask sensitive fields in logs
