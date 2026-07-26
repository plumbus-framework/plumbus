# Capabilities

Capabilities are the **atomic units of business logic** in Plumbus. Every operation in the system — queries, mutations, background jobs, and event handlers — is a capability.

## Anatomy of a Capability

```typescript
import { defineCapability } from "@plumbus/core";
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
    data: ["Refund"],
    events: ["refund.approved"],
    external: [],
    ai: false,
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
| `job` | POST (202) | Async, background queue | Long-running operations, reports. Can be exposed to AI agents via MCP tasks — see [tasks-and-jobs](../mcp/tasks-and-jobs.md). |
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
- Returns `202 Accepted` with `{ data: { jobId, status: "accepted" } }` when the API wires `jobQueue` (any job capability — not gated on worker pool)
- Creates a `job_executions` row and publishes to the shared jobs queue
- Poll status: `GET /api/jobs/:jobId` → `{ data: { jobId, status, output, error, … } }` (owner or admin). Statuses include `dead_lettered`.

### Event Handler

```typescript
defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  trigger: { event: "order.placed" },
  // ...
  handler: async (ctx, input) => {
    await ctx.data.Shipment.create({ orderId: input.orderId });
  },
});
```

- Not exposed as HTTP route
- Auto-registered as a queue consumer when `trigger.event` is set
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
2. If no authenticated caller (`auth.userId`) → deny
3. If caller matches `serviceAccounts` → allow
4. If `tenantScoped: true` → require `auth.tenantId` and tenant match
5. Check caller has at least one required role
6. Check caller has required scopes

## Effects Declaration

Effects document what a capability does — used by governance and audit:

```typescript
effects: {
  data: ["Order"],                     // Entities written (governance reads this to gate write access)
  events: ["order.updated"],           // Events emitted
  external: ["payment-gateway"],       // External service calls
  capabilities: ["billing.getInvoice"], // Canonical names this capability may invoke via ctx.capabilities.invoke
  ai: false,                           // `true` if the handler calls `ctx.ai.*`
}
```

## Capability-to-capability invocation

Capabilities may **not** import and call another capability's handler directly. The only sanctioned path for synchronous composition is `ctx.capabilities.invoke(name, input)`.

- **Canonical names:** use `<domain>.<capabilityName>` everywhere — e.g. `billing.approveRefund`. The local `name` field in `defineCapability` stays short (`approveRefund`); the framework derives the canonical name from `domain` + `name`.
- **Declared dependencies:** the target must appear in `effects.capabilities`. Undeclared calls, cycles, missing targets, and job targets produce `dependencyViolation` errors at runtime.
- **Full pipeline:** nested calls run through `executeCapability` (validation, access, audit, output validation). The callee inherits the caller's auth, transaction scope, and correlation context.
- **Handler surface:** capability handlers receive `ctx.capabilities.invoke` only. Internal registry invokers are not exposed on `ctx.__runtime` — bypassing the policy layer is not supported. The single exception is framework-internal and not extensible: `stripHandlerRuntime` preserves the full runtime (`invokeCapability`, `resolveCapability`, `invocationEmitScope`) for the built-in `chat.chatConfirmAction`, which must re-enter the pipeline to execute a user-confirmed action. The carve-out is keyed on that exact canonical name, so an application capability can never receive it.
- **Nested events:** when a callee emits via `ctx.events.emit()`, the outbox envelope's `causationId` is set to the caller's canonical capability name (or the executing capability when not nested).
- **Nested audit:** success audit rows for nested `ctx.capabilities.invoke` calls include a `caller` field with the invoking capability's canonical name.
- **Job capabilities** cannot be invoked synchronously — use job dispatch, flows, or events. Flow `capability` steps reject `kind: 'job'` targets at runtime.
- **Flows remain preferred** for multi-step orchestration. Use `ctx.capabilities.invoke` when you need a callee's result in the same execution path.

```typescript
handler: async (ctx, input) => {
  const invoice = await ctx.capabilities.invoke("billing.getInvoice", {
    id: input.invoiceId,
  });
  // ...
};
```

See [upgrading-capability-names](../upgrading-capability-names.md) when migrating existing apps to canonical names.

## Transactional outbox

`action` and `eventHandler` capabilities run handler + output validation inside a single database transaction by default so entity writes and `ctx.events.emit()` outbox rows commit or roll back together.

- **Opt out globally:** `execution.transactionalOutbox: false` or `PLUMBUS_TRANSACTIONAL_OUTBOX=false`.
- **Opt out per capability:** `transactional: false` on `defineCapability({ ... })`.
- **Auto-excluded:** `kind: 'job'`, `effects.ai: true`, non-empty `effects.external`, and `query` capabilities keep the prior non-transactional behavior.
- **Deferred side effects:** `ctx.flows.start()` and `ctx.jobs.enqueue()` inside a transaction defer until after commit. `flows.start` returns a placeholder execution id with `status: 'pending'`; `enqueue` returns a pre-allocated job id immediately.

See [Upgrading for contract alignment → transactional outbox](../upgrading-contract-alignment.md#1-transactional-outbox-default-on-a1).

## Runtime contract notes

| Area | Behavior |
|------|----------|
| AI security | Active only when `aiProviders.security` is configured; entity registry is merged at bootstrap when enabled |
| Encrypted fields | With `PLUMBUS_ENCRYPTION_KEY` set, repositories reject `findMany`, `aggregate`, and filter queries that target `encrypted: true` string fields |
| Chat action decline | `chatConfirmAction` with `execute: false` is idempotent — already-rejected or missing pending rows return `{ executed: false }` without error |
| KB ranker (K13) | Source-level `defineKnowledgeSource({ ranker })` runs when the provider factory did not declare a ranker; factory ranker wins |
| Context resolver | Per-source timeout (default 5s) aborts hung sources; skipped timeouts emit `ctx.logger.warn` and the turn continues |

## Error Handling

Use structured errors from `ctx.errors`:

```typescript
handler: async (ctx, input) => {
  const user = await ctx.data.User.findById(input.userId);
  if (!user) throw ctx.errors.notFound("User not found");

  if (!ctx.security.hasRole("admin")) {
    throw ctx.errors.forbidden("Admin role required");
  }

  const [existing] = await ctx.data.User.findMany({ email: input.email });
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

## Generated Types

Running `plumbus generate` produces typed artifacts from capability contracts:

- **`capability-types.ts`** — `Input`/`Output` types inferred from Zod schemas, plus a `CapabilityName` union type
- **`clients/api.ts`** — typed fetch functions that import from `capability-types.ts`
- **`clients/hooks.ts`** — React hooks that import from `capability-types.ts`

Example generated types for `approveRefund`:

```typescript
// .plumbus/generated/capability-types.ts
export type ApproveRefundInput = {
  refundId: string;
  reason?: string;
};
export type ApproveRefundOutput = {
  refundId: string;
  status: "approved";
  approvedAt: string;
};

export type CapabilityName = "billing.approveRefund" | "billing.getInvoice";
```

The `CapabilityName` type can be used for type-safe capability references (e.g. with `runCapability`).

## MCP exposure (optional)

Capabilities can be exposed to AI agents over MCP without a separate primitive:

```typescript
defineCapability({
  name: "getRefund",
  kind: "query",
  exposeAs: ["mcp"],
  mcp: {
    description: "Look up a refund for support agents",
    agentTags: ["billing"],
  },
  access: {
    serviceAccounts: ["billing-agent"],
    tenantScoped: true,
  },
  // ...
});
```

- Only `exposeAs: ['mcp']` opts in; tags do not grant MCP exposure.
- `job` and `eventHandler` kinds cannot be MCP-exposed.
- `plumbus generate` adds `mcp-manifest.json` and `skills/<domain>/<kebab>.md`.
- Runtime: `plumbus mcp serve` (see [MCP overview](../mcp/overview.md)).

---

## SDK reference

For every `defineCapability` option (including `tags`, `owner`, `audit`, `explanation`, `mcp`, `exposeAs`, and all undocumented advanced flags), see [SDK Reference → defineCapability](../sdk-reference/define-functions.md#definecapability). This page covers the common case; the reference is exhaustive.

