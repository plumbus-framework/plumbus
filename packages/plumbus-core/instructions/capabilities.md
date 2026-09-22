# Capabilities

A capability is a discrete unit of business logic. It is the **only** way business logic executes in Plumbus.

## Defining a Capability

```ts
import { defineCapability } from "@plumbus/core";
import { z } from "zod";

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

Inside an active transaction, `ctx.flows.start()` and `ctx.jobs.enqueue()` defer until after commit (pre-allocated ids). Nested success audits also defer until commit. Prefer `transactional: false` on parents that invoke AI capabilities — otherwise the parent transaction is held open for the LLM call (one-time warn).

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
