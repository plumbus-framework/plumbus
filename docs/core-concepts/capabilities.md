# Capabilities

Capabilities are the **atomic units of business logic** in Plumbus. Every operation in the system — queries, mutations, background jobs, and event handlers — is a capability.

## Anatomy of a Capability

```typescript
import { defineCapability } from "plumbus-core";
import { z } from "zod";

export const approveRefund = defineCapability({
  name: "approveRefund",
  kind: "action",
  domain: "billing",
  description: "Approve a pending refund request",
  input: z.object({
    refundId: z.string().uuid(),
    reason: z.string().optional(),
  }),
  output: z.object({
    refundId: z.string(),
    status: z.literal("approved"),
    approvedAt: z.string(),
  }),
  access: {
    roles: ["billing_manager"],
    scopes: ["refunds:approve"],
    tenantScoped: true,
  },
  effects: {
    reads: ["Refund", "Customer"],
    writes: ["Refund"],
    emits: ["refund.approved"],
  },
  handler: async (ctx, input) => {
    // Business logic here
  },
});
```

## Capability Kinds

| Kind | HTTP Method | Behavior | Use Case |
|------|------------|----------|----------|
| `query` | GET | Synchronous, read-only | Fetch data, search, list |
| `action` | POST | Synchronous, may mutate | Create, update, delete |
| `job` | POST (202) | Async, background queue | Long-running operations, reports |
| `eventHandler` | — (internal) | Triggered by events | Side effects, notifications |

### Query

```typescript
defineCapability({
  name: "getUser",
  kind: "query",
  // ...
  handler: async (ctx, input) => {
    return ctx.data.User.findById(input.userId);
  },
});
```

- Routed as `GET /api/{domain}/{kebab-name}`
- Input sent as query parameters
- Should not mutate data

### Action

```typescript
defineCapability({
  name: "createUser",
  kind: "action",
  // ...
  handler: async (ctx, input) => {
    const user = await ctx.data.User.create(input);
    await ctx.events.emit("user.created", { userId: user.id });
    return user;
  },
});
```

- Routed as `POST /api/{domain}/{kebab-name}`
- Input sent as JSON body
- Typically creates, updates, or deletes data

### Job

```typescript
defineCapability({
  name: "generateReport",
  kind: "job",
  // ...
  handler: async (ctx, input) => {
    // Long-running operation
    const report = await buildReport(input);
    return { reportId: report.id };
  },
});
```

- Routed as `POST /api/{domain}/{kebab-name}`
- Returns `202 Accepted` with `{ jobId, status: "accepted" }`
- Actual execution happens in background via event queue

### Event Handler

```typescript
defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  // ...
  handler: async (ctx, input) => {
    await ctx.data.Shipment.create({ orderId: input.orderId });
  },
});
```

- Not exposed as HTTP route
- Triggered by the event worker when a matching event arrives
- Must declare `serviceAccounts` in access policy

## Access Policies

Every capability **must** declare an access policy. The framework evaluates it before handler execution:

```typescript
access: {
  // Role-based access
  roles: ["admin", "billing_manager"],

  // Scope-based access
  scopes: ["refunds:approve"],

  // Public access (no auth required)
  public: true,

  // Restrict to same tenant
  tenantScoped: true,

  // Service account access (for event handlers)
  serviceAccounts: ["event-worker", "scheduler"],
}
```

Evaluation order:
1. If `public: true` → allow
2. Check caller has at least one required role
3. Check caller has required scopes
4. If `tenantScoped: true` → verify tenant match

## Effects Declaration

Effects document what a capability does — used by governance and audit:

```typescript
effects: {
  reads: ["User", "Order"],           // Entities read
  writes: ["Order"],                   // Entities mutated
  emits: ["order.updated"],            // Events emitted
  external: ["payment-gateway"],       // External service calls
  ai: ["classifyOrder"],               // AI prompts used
}
```

## Error Handling

Use structured errors from `ctx.errors`:

```typescript
handler: async (ctx, input) => {
  const user = await ctx.data.User.findById(input.userId);
  if (!user) throw ctx.errors.notFound("User not found");

  if (!ctx.security.hasRole("admin")) {
    throw ctx.errors.forbidden("Admin role required");
  }

  const existing = await ctx.data.User.findByEmail(input.email);
  if (existing) throw ctx.errors.conflict("Email already in use");

  // Validation errors
  if (input.amount < 0) {
    throw ctx.errors.validation("Amount must be positive");
  }

  // Internal errors
  throw ctx.errors.internal("Unexpected state");
}
```

## File Structure Convention

```
app/capabilities/{domain}/{kebab-name}/
├── capability.ts    # Contract (defineCapability)
├── impl.ts          # Handler implementation (optional split)
└── tests/
    ├── {name}.test.ts
    └── fixtures/
```

