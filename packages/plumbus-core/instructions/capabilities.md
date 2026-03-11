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
