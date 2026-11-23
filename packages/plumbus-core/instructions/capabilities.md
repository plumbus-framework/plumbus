# Capabilities

A capability is a discrete unit of business logic. It is the **only** way business logic executes in Plumbus.

## Defining a Capability

```ts
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const getUser = defineCapability({
  name: "getUser",
  kind: "query",
  domain: "users",
  description: "Fetches a user by ID",

  input: z.object({ userId: z.string().uuid() }),
  output: z.object({ id: z.string(), name: z.string(), email: z.string() }),

  access: { roles: ["admin", "user"], tenantScoped: true },

  effects: {
    data: ["User"],
    events: [],
    external: [],
    capabilities: [], // canonical invoke targets: ["billing.getInvoice"]
    ai: false,
  },

  audit: { event: "user.fetched", includeInput: ["userId"] },

  explanation: { enabled: true, summary: "Fetches user profile data" },

  handler: async (ctx, input) => {
    const user = await ctx.data.User.findById(input.userId);
    if (!user) throw ctx.errors.notFound("User not found");
    return { id: user.id, name: user.name, email: user.email };
  },
});
```

## Capability Kinds

| Kind | HTTP Method | Behavior |
|------|------------|----------|
| `query` | GET | Read-only, idempotent, cacheable |
| `action` | POST | Write operation, side effects expected |
| `job` | POST (async) | Long-running, returns job handle immediately |
| `eventHandler` | Internal only | Triggered by event delivery, not exposed via HTTP |

Every capability call writes an audit row by default, queries included. An app may set `execution.auditSuccessfulQueries: false` (`PLUMBUS_AUDIT_SUCCESSFUL_QUERIES=false`) to skip the row of a **successful** `query`; a query whose reads must stay on the audit trail sets `audit: { enabled: true, event: "..." }`. Failed and denied calls are always recorded.

- A transactional action's success row is written inside its transaction (commits with its data). An action without a framework transaction never fails because its success row could not be written: the row is retried and an error is logged (`[plumbus] audit record …`). Queries still fail when their row cannot be written.
- `audit: { event, success: false }` drops only the success row of a high-volume action whose data rows already record it; denied and failed calls are still recorded.
- `audit: { event, deferSuccess: true }` on an action with `transactional: false` (or AI/external effects) that runs its own database transaction: success rows wait until the handler ends, so the handler never waits for an audit insert on a second connection.

## Handler Pattern

The handler receives two arguments:
- `ctx` — the execution context (see `framework.md`)
- `input` — pre-validated input matching the `input` Zod schema

The handler must return a value matching the `output` Zod schema.

### Using `ctx.data`

```ts
handler: async (ctx, input) => {
  // Create
  const order = await ctx.data.Order.create({ customerId: input.customerId, total: input.total });
  // Read
  const customer = await ctx.data.Customer.findById(input.customerId);
  // Update
  await ctx.data.Order.update(order.id, { status: "confirmed" });
  // Query (unpaginated — fine for small bounded sets)
  const recent = await ctx.data.Order.findMany({ customerId: input.customerId });
  // Paginated list endpoints — push limit/offset/filters to SQL via findMany + count
  const items = await ctx.data.Order.findMany(
    { customerId: input.customerId },
    { orderBy: "createdAt", orderDir: "desc", limit: input.limit, offset: (input.page - 1) * input.limit },
  );
  const total = await ctx.data.Order.count({ customerId: input.customerId });
  // Dashboard totals / grouped stats — aggregate in SQL, not findMany + reduce in memory
  const [monthTotals] = await ctx.data.Order.aggregate(
    { customerId: input.customerId },
    { dateFilters: { createdAt: { gte: monthStart } }, sum: "total", count: true },
  );
  return { orderId: order.id, monthTotal: monthTotals.sum_total, monthCount: monthTotals.count };
}
```

For `SUM` / `AVG` / `MIN` / `MAX` / `COUNT` / `COUNT(DISTINCT)` and optional `GROUP BY`, use `aggregate()` — see [entities.md](./entities.md#aggregates-sum--group-by--distinct) and the [Data Layer SDK reference](../../../docs/sdk-reference/data-layer.md#aggregatequery-options).

### Using `ctx.events`

```ts
handler: async (ctx, input) => {
  const refund = await ctx.data.Refund.create(input);
  await ctx.events.emit("refund.requested", { refundId: refund.id, amount: refund.amount });
  return { refundId: refund.id };
}
```

### Using `ctx.ai`

```ts
handler: async (ctx, input) => {
  const result = await ctx.ai.generate({ prompt: "summarizeTicket", input: { text: input.ticketText } });
  return { summary: result.summary };
}
```

### Using `ctx.flows`

```ts
handler: async (ctx, input) => {
  const execution = await ctx.flows.start("approvalWorkflow", { requestId: input.requestId });
  return { flowExecutionId: execution.id };
}
```

## Answering with bytes (streamed answers)

(core 0.9.0-beta.16+; generated client: `@plumbus/ui` 0.10.0-beta.6+; partner routes: `@plumbus/api` 0.4.0-beta.6+.) A capability whose answer is a file (an export archive, a PDF, a CSV) declares
`output: streamedBodyOutput` and returns `streamedBody(source, options)`. The route sends the
source as the HTTP body while the client reads it, so the answer is never held in memory and
can be larger than any JSON body (a V8 string stops near 512 MiB).

```ts
import { defineCapability, streamedBody, streamedBodyOutput } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const downloadInvoicePdf = defineCapability({
  name: 'downloadInvoicePdf',
  kind: 'query',
  domain: 'billing',
  input: z.object({ invoiceId: z.string().uuid() }),
  output: streamedBodyOutput,
  access: { roles: ['accountant'], tenantScoped: true },
  effects: { data: ['Invoice'], events: [], external: ['object-storage'], ai: false },
  exposeAs: ['api'],
  api: { operationId: 'downloadInvoicePdf', method: 'GET', path: '/invoices/{invoiceId}/pdf' },
  handler: async (ctx, input) => {
    const invoice = await ctx.data.Invoice.findById(input.invoiceId);
    if (!invoice) throw ctx.errors.notFound('Invoice not found');
    const object = await openStoredObject(invoice.pdfKey); // a Readable or async iterable of bytes
    return streamedBody(object.body, {
      contentType: 'application/pdf',
      contentLength: object.size,          // optional; a source of another size breaks the transfer
      fileName: `invoice-${invoice.number}.pdf`,
    });
  },
});
```

- Everything before the handler is unchanged: authentication, the access policy, `authorize`,
  the executor's success audit row. A refusal is the usual JSON error.
- Headers: `content-type`, `content-length` (when given), `content-disposition` (when
  `fileName` is given; ASCII fallback plus `filename*`), `x-content-type-options: nosniff`,
  `cache-control: no-store`.
- The source is read after the handler returns. A query's data-plane lease is held until the
  response ends, so a source may page through `ctx.data` of a **query** while it is sent. An
  action's transaction has already committed: its source must not use the transaction's
  `ctx.data`; read from storage, a file, or its own connection.
- A source that fails, or yields a size other than `contentLength`, ends the response abruptly
  (never a complete-looking file) and logs `Capability "<name>" streamed answer failed while
  sending`. A client that goes away destroys the source (an async generator's `finally` runs).
- Not allowed (refused by `defineCapability`): `kind: 'job'` or `'eventHandler'`,
  `exposeAs: ['mcp']`, `api.idempotency.required` (a stream cannot be stored and replayed).
  `@plumbus/api` refuses a manifest entry that makes such an operation idempotent.
- Clients: the generated client (`plumbus ui generate`, `@plumbus/ui`) types the output as the
  fetch `Response` and returns it unread (`await (await downloadInvoicePdf(input)).blob()`, or
  read `response.body`). Partner routes (`@plumbus/api`) send the same bytes, and the OpenAPI
  document describes them as `application/octet-stream`.

## Effects Declaration

Every capability must declare its side effects in the `effects` field:

- `data` — entity names this capability reads from or writes to
- `events` — event types this capability may emit
- `external` — external integrations this capability calls (APIs, services)
- `capabilities` — canonical names (`<domain>.<name>`) this handler may invoke via `ctx.capabilities.invoke`
- `flows` — flow names this capability may start (optional)
- `ai` — whether this capability uses AI operations

Effects are used by governance rules to analyze the system.

## Transactional outbox (default ON)

For `kind: 'action'` and `kind: 'eventHandler'`, handler execution and output validation run inside a single database transaction by default. Entity writes via `ctx.data.*` and `ctx.events.emit()` outbox inserts commit or roll back together.

**Auto-excluded** (non-transactional): `kind: 'job'`, `effects.ai: true`, non-empty `effects.external`, and other kinds (e.g. `query`).

**Recommended:** keep the default ON and fix handlers that assumed partial commits. There is no framework-wide legacy/soft mode.

**Opt out (per app or capability — not the long-term default):**
- Globally: `execution.transactionalOutbox: false` in config, or `PLUMBUS_TRANSACTIONAL_OUTBOX=false`
- Per capability: `transactional: false` on `defineCapability({ ... })`

### When the transaction opens (lazy by default)

The transaction opens at the handler's **first use that needs it**, not before the handler runs:
the first `ctx.data` write (`create`, `createMany`, `update`, `updateWhere`, `delete`), the first
`ctx.events.emit`/`emitMany`, the first durable `ctx.flows.start`, the first `ctx.jobs.enqueue`.
A handler that never does any of these opens no transaction and holds no database connection
while it works (calls to other services, reads, waits). Everything written from the first write on
still commits or rolls back together; a throw or invalid output rolls all of it back.

What changes is **reads before the first write**: they run on the pool, outside the transaction.
Under PostgreSQL's default `READ COMMITTED` that is not observable — each statement takes its own
snapshot either way, plain reads take no row locks, and the repository has no `FOR UPDATE`. It is
observable only when the database or role runs transactions at `REPEATABLE READ`/`SERIALIZABLE`
(the read no longer shares the transaction's snapshot or serializability checks), or when code
reached into the internal `ctx.__runtime.transactionScope.db` handle (now `undefined` until
something opens the transaction). Reads after the first write run in the transaction and see its
writes.

- Need the old behaviour for one capability? `transactional: 'eager'` (opens before the handler).
- For the whole app: `execution.transactionBegin: 'eager'` or `PLUMBUS_TRANSACTION_BEGIN=eager`.
- `transactional: 'lazy'` forces lazy where the host chose eager. `true` follows the host.
- For a read-modify-write that must not lose a race, use `updateWhere` (compare-and-set) — it was
  needed under `READ COMMITTED` before this change too.

**Bounded wait for a connection:** opening the transaction waits at most
`execution.transactionAcquireTimeoutMs` (`PLUMBUS_TRANSACTION_ACQUIRE_TIMEOUT_MS`, default 10000;
`0` = no limit) for a free pool connection. Past it the call fails with
`DataPoolAcquireTimeoutError` — HTTP 503 with `Retry-After`, `metadata.reason:
'pool-acquire-timeout'` — and nothing is written. The bound covers opening the capability's
transaction, not every query on the pool.

Inside an active transaction, `ctx.flows.start()` defers until after commit. Built-in `ctx.jobs.enqueue()` persists job intent in the active transaction and publishes after commit; rollback removes the intent. Publication failures remain queued for worker recovery. Returned job IDs mean acceptance, not completion. Nested success audits also defer until commit. `ctx.audit.record` inside the transaction writes on the transaction's connection (default audit service): it commits with the data, and on rollback only `failure`/`denied` records are kept. Prefer `transactional: false` on parents that invoke AI capabilities — otherwise a parent transaction that is already open is held open for the LLM call (one-time warn). With the lazy default, do the AI call before the first write when you can. `ctx.audit.record` made before the transaction opens: `success` records are held and written with the transaction (or after the handler returns, if it never opened one) and dropped if the handler throws; `failure`/`denied` records are written at once.

See `docs/upgrading-contract-alignment.md` (Migration stance + §1) and `docs/architecture/execution-lifecycle.md`.

## Capability-to-capability invocation

The only sanctioned path for synchronous composition is `ctx.capabilities.invoke`:

```ts
handler: async (ctx, input) => {
  const invoice = await ctx.capabilities.invoke("billing.getInvoice", {
    invoiceId: input.invoiceId,
  });
  return { invoice };
}
```

Rules:

- Declare every invoke target in `effects.capabilities` using **canonical names** (`billing.getInvoice`, not `getInvoice`).
- Undeclared calls, cycles, missing targets, and synchronous job invokes fail at runtime with `dependencyViolation`.
- Do **not** import other capability handlers or call `.handler` directly — `plumbus verify` flags direct handler imports.
- Handler-visible `ctx.__runtime` does not expose internal invokers; use `ctx.capabilities.invoke` only. (One framework-internal exception: the built-in `chat.chatConfirmAction` capability receives the unstripped runtime, matched by canonical name in `capability-executor.ts`. Application capabilities cannot opt into this.)
- Prefer flows for multi-step orchestration; use invoke when you need a callee's result in the same execution path.

The local `name` field in `defineCapability` stays short (`getInvoice`); the framework derives the canonical registry key from `domain` + `name`. Run `plumbus generate` after changes so `RegisteredCapabilityName` and manifests stay in sync.

## Explanation Tracking

Capabilities that use AI (`effects.ai: true`) should enable explanation tracking:

```ts
explanation: {
  enabled: true,    // Enable AI explanation tracking
  summary: "...",   // Human-readable description of AI usage
},
```

The governance rule `ruleAIWithoutExplanation` warns when a capability has `effects.ai: true` but doesn't set `explanation.enabled: true`.

## Error Handling

Use `ctx.errors` to throw structured errors:

```ts
throw ctx.errors.validation("Email is required");
throw ctx.errors.notFound("Invoice not found");
throw ctx.errors.forbidden("Cannot access this resource");
throw ctx.errors.conflict("Email already exists");
throw ctx.errors.internal("Payment provider unavailable");
```

These map to HTTP status codes: 400, 404, 403, 409, 500.

These are the **only** structured error types. If you need a custom error, use `ctx.errors.internal()` with a descriptive message.

Errors are `PlumbusError` instances (extends `Error`) with `code`, `message`, and optional `metadata`. They serialize to JSON via `toJSON()` and can be detected with `isPlumbusError()` (supports both `instanceof` and duck-type checks for cross-version compatibility).

**Do not** use `throw new Error(...)` in capability handlers — always use `ctx.errors.*()` for proper HTTP status mapping and structured error responses.

## MCP Exposure (Optional)

A capability can be exposed to **external AI agents** as a Model Context Protocol tool by adding `exposeAs: ['mcp']`. The default is HTTP-only; MCP is opt-in per capability.

```ts
export const getRefund = defineCapability({
  name: "getRefund",
  kind: "query",
  domain: "billing",
  description: "Fetch a refund by id",

  // Opt in to MCP exposure
  exposeAs: ["mcp"],
  mcp: {
    description: "Look up a refund for billing support agents",  // agent-facing override
    dangerous: false,           // sets MCP annotations.destructiveHint
    agentTags: ["billing"],     // categorization hint for agent tool selection
  },

  // Restrict which agents may call this — service-account-style auth
  access: {
    serviceAccounts: ["billing-agent"],
    tenantScoped: true,
  },

  // ...input, output, effects, handler unchanged
});
```

**Rules when MCP-exposed:**
- `kind: "query"` and `kind: "action"` are standard MCP tools.
- `kind: "job"` is exposed via MCP Tasks (`tools/call` + `_meta.taskMetadata`). Register `mcpTaskEntity` in the app entity list.
- Only `kind: "eventHandler"` is rejected at `defineCapability()` time for MCP exposure.
- Either `description`, `mcp.description`, or `explanation.summary` is required.
- Agent identity is controlled via `access.serviceAccounts` and `access.scopes`. Deny-by-default still holds.

Read `node_modules/@plumbus/core/instructions/mcp.md` and `node_modules/@plumbus/mcp/instructions/README.md` for MCP (auth, transports, tasks, testing).

## Job Capabilities

Capabilities with `kind: "job"` are for long-running operations. They return immediately with a job handle, and the work executes asynchronously.

```ts
export const generateReport = defineCapability({
  name: "generateReport",
  kind: "job",
  domain: "reports",

  input: z.object({ reportType: z.string(), dateRange: z.object({ from: z.string(), to: z.string() }) }),
  output: z.object({ reportId: z.string(), estimatedDuration: z.number() }),

  access: { roles: ["admin", "analyst"], tenantScoped: true },
  effects: { data: ["Report"], events: ["report.generated"], external: [], ai: true },

  handler: async (ctx, input) => {
    const report = await ctx.data.Report.create({
      type: input.reportType,
      status: "queued",
      dateFrom: input.dateRange.from,
      dateTo: input.dateRange.to,
    });
    return { reportId: report.id, estimatedDuration: 120 };
  },
});
```

Job capabilities are exposed as `POST` endpoints. From **0.5.0**, when the API wires `jobQueue` (any job capability on `plumbus dev` / `plumbus start` — including in-memory queues), routes return **`202 Accepted`** with `{ data: { jobId, status: "accepted" } }` and enqueue via the jobs queue. This is **not** gated on whether a worker pool runs in the same process; `PLUMBUS_RUNTIME_ROLE=api` still returns **202** but needs a separate `plumbus worker` to execute jobs.

Poll completion with:

```
GET /api/jobs/:jobId
```

Response: `{ data: { jobId, status, output, error, … } }`. Status values include `queued`, `running`, `completed`, `failed`, and `dead_lettered` from `job_executions`. Run `plumbus migrate generate && plumbus migrate apply` **before** job traffic — routes fail at the DB layer if the table is missing.

**Pre-0.5.0 note:** job routes often returned **200** with the handler output synchronously because the server did not wire a job queue. Update HTTP clients that assumed synchronous job responses. See `deployment.md` (Upgrading to 0.5) for the full checklist.


Core 0.8 wires `ctx.jobs.enqueue()` in standard flow contexts under the original caller's tenant and authorization. An explicit UUID `jobId` is idempotent only for the same caller/tenant, target, and validated input; conflicting reuse fails. Business-level retries still require application idempotency. Custom transaction/dispatch adapters without durable transaction binding retain their explicitly configured semantics.

Queued job input must survive a JSON round trip. The built-in dispatcher persists and compares the validated JSON representation (dates as ISO strings, big integers as decimal strings). Use coercing input schemas such as `z.coerce.date()` and `z.coerce.bigint()` so workers can validate the serialized payload. Unsupported non-serializable inputs fail before a job ID is accepted.
