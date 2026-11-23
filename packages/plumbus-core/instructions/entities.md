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

`notIn: { field: [values] }` (core 0.9.0-beta.16+) keeps only rows whose column holds none of the values (`col <> ALL(...)`, one array parameter like `in`): `notIn: { accountId: heldAccountIds }`. An empty `notIn` list excludes nothing. As with `notEq` (and SQL `NOT IN`), a row whose column is NULL does **not** match; leave nullable columns out of it or fetch the NULL rows separately.

`in: { field: [] }` (an empty list) matches **no** rows. To make an `in` filter optional, leave the key out when there is nothing to filter by: `...(ids.length ? { in: { id: ids } } : {})`. An `in` list of ids, text or numbers travels as one array parameter, so a list of any length works (no chunking needed for the 65,535-parameter limit).

### Deleting or updating many rows (set-based writes)

Never load rows only to delete or update them one by one. Use `deleteMany` / `updateMany`, which change at most `limit` matching rows in one statement and return `{ count, ids }`:

```ts
// Purge in bounded batches.
for (;;) {
  const { count } = await ctx.data.UsageCounter.deleteMany!(undefined, { dateFilters: { day: { lte: cutoff } }, limit: 500 });
  if (count < 500) break;
}
// Update a set; exclude rows already changed if you loop.
await ctx.data.Hold.updateMany!({ batchId }, { state: 'released' }, { notEq: { state: 'released' }, limit: 1000 });
```

- `limit` is required. Filters are those of `findMany` (`query`, `dateFilters`, `in`, `notIn`, `notEq`, `search`, `contains`); `orderBy` picks which rows a call takes.
- Audit: by default one audit row per affected record, exactly what a loop of `delete(id)` / `update(id, …)` writes. Pass `audit: 'summary'` for one row per statement (count + masked filter, no ids) only where the per-record trail is not needed.
- `updateMany` cannot set `id` or `tenantId`.
- When you do not use the updated row, `update(id, values, { returning: false })` skips reading it back.

### Indexes beyond plain fields (core 0.9.0-beta.17+)

An index entry may name framework columns (`id`, `createdAt`, `updatedAt`, and `tenantId` on a tenant-scoped entity), give per-column options, index SQL expressions, be partial, and use any index method:

```ts
indexes: [
  // Newest first within a tenant (ORDER BY created_at DESC LIMIT n).
  { columns: ['tenantId', 'createdAt'], columnOptions: { createdAt: { order: 'desc' } } },
  // Case-insensitive sort or lookup: expressions in database column names; a name is required.
  { columns: [], expressions: ['lower(display_name)'], name: 'customer_display_name_lower_idx' },
  // Partial: only the rows a sweep reads.
  { columns: ['state'], where: "state = 'pending'", name: 'invoice_pending_idx' },
  // Substring search (ILIKE '%x%'): trigram GIN; create the extension with `plumbus migrate new`.
  { columns: ['displayName'], columnOptions: { displayName: { opclass: 'gin_trgm_ops' } }, using: 'gin', name: 'customer_display_name_trgm_idx' },
]
```

- `columnOptions[column]`: `order` (`'asc'` / `'desc'`), `nulls` (`'first'` / `'last'`; default PostgreSQL's own, so `ORDER BY col DESC` can read a `desc` key), `opclass` (an operator class name).
- `using`: `btree` (default), `gin`, `gist`, `hash`, `brin`. `gin` on one json field with no `opclass` keeps its meaning (`jsonb_path_ops`, for `contains`).
- `expressions` and `where` are SQL fragments in database column names (snake_case), one expression each, no `;`. They are passed to the migration as written.
- `plumbus migrate generate` emits them like any index (`CREATE INDEX IF NOT EXISTS …`). On a large table make the file concurrent (see non-transactional migrations).

### Inserting many rows

Use `createMany(records)` instead of `create()` in a loop: one INSERT for the whole list. By default it writes one summary audit row per call (`<Entity>.createMany`, count and a masked sample). Pass `{ audit: 'per-row' }` (core 0.9.0-beta.16+) when every record must leave the same audit row a `create()` writes (`<Entity>.create`, masked fields masked), inserted together:

```ts
for (let i = 0; i < lines.length; i += 500) {
  await ctx.data.InvoiceLine.createMany(lines.slice(i, i + 500), { audit: 'per-row' });
}
```

Keep a call to a few hundred or thousand records (every column of every record is a bind parameter).

### JSON containment

`contains: { jsonField: value }` filters on a `field.json()` column with `@>` (`{ assetIds: [assetId] }`). Declare `indexes: [{ columns: ['assetIds'], using: 'gin' }]` on the entity so the filter uses a GIN index instead of reading every row.

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
