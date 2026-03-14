# Capabilities

A capability is a discrete unit of business logic. It is the **only** way business logic executes in Plumbus.

## Defining a Capability

```ts
import { defineCapability } from "plumbus-core";
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
  // Query
  const recent = await ctx.data.Order.findMany({ customerId: input.customerId });
  return { orderId: order.id };
}
```

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
- `flows` — flow names this capability may start (optional)
- `ai` — whether this capability uses AI operations

Effects are used by governance rules to analyze the system.

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

Job capabilities are exposed as `POST` endpoints that return `202 Accepted` with the job output. The framework provides job status tracking and progress monitoring automatically.
