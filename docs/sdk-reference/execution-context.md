# Execution Context Reference

The `ExecutionContext` (`ctx`) is the single parameter injected into every capability handler. It provides access to all framework services.

## Context Shape

```typescript
interface ExecutionContext {
  auth: AuthContext;           // Caller identity
  data: DataService;           // Entity repositories
  events: EventService;        // Event emitter
  flows: FlowService;          // Flow orchestrator
  ai: AIService;               // AI operations
  audit: AuditService;         // Audit trail
  errors: ErrorService;        // Structured errors
  logger: LoggerService;       // Structured logging
  time: TimeService;           // Clock abstraction
  config: ConfigService;       // App configuration
  security: SecurityService;   // Authorization helpers
  state?: unknown;             // Flow state (flows only)
  step?: string;               // Current step (flows only)
  flowId?: string;             // Flow execution ID (flows only)
}
```

---

## ctx.auth

Identity and authorization context of the caller.

```typescript
interface AuthContext {
  userId?: string;
  roles: string[];
  scopes: string[];
  tenantId?: string;
  provider: string;
  sessionId?: string;
  authenticatedAt?: Date;
}
```

```typescript
handler: async (ctx, input) => {
  const tenantId = ctx.auth.tenantId;
  const userId = ctx.auth.userId;
  const isAdmin = ctx.auth.roles.includes("admin");
}
```

---

## ctx.data

Repository access for all registered entities. Each entity gets a typed repository:

```typescript
interface Repository<T> {
  findById(id: string): Promise<T | null>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  findMany(query?: Record<string, unknown>): Promise<T[]>;
}
```

```typescript
handler: async (ctx, input) => {
  // Create
  const order = await ctx.data.Order.create({
    customerId: input.customerId,
    total: input.total,
  });

  // Read
  const customer = await ctx.data.Customer.findById(input.customerId);

  // Query
  const orders = await ctx.data.Order.findMany({
    customerId: input.customerId,
  });

  // Update
  await ctx.data.Order.update(order.id, { status: "confirmed" });

  // Delete
  await ctx.data.Order.delete(order.id);
}
```

Repositories enforce:
- **Tenant isolation** — queries auto-filter by `ctx.auth.tenantId`
- **Audit logging** — mutations are recorded
- **Soft delete** — configurable per entity

---

## ctx.events

Emit domain events:

```typescript
interface EventService {
  emit(eventName: string, payload: unknown): Promise<void>;
}
```

```typescript
handler: async (ctx, input) => {
  await ctx.data.Order.create(input);
  await ctx.events.emit("order.placed", {
    orderId: input.orderId,
    total: input.total,
  });
}
```

Events are written to the outbox within the same database transaction as data mutations, guaranteeing at-least-once delivery.

---

## ctx.flows

Start, resume, cancel, and check flow executions:

```typescript
interface FlowService {
  start(flowName: string, input: unknown): Promise<FlowExecution>;
  resume(executionId: string, signal?: unknown): Promise<void>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<FlowExecution>;
}
```

```typescript
handler: async (ctx, input) => {
  // Start a flow
  const execution = await ctx.flows.start("orderFulfillment", {
    orderId: input.id,
  });

  // Check status
  const status = await ctx.flows.status(execution.id);

  // Resume a paused flow
  await ctx.flows.resume(execution.id, { approved: true });

  // Cancel
  await ctx.flows.cancel(execution.id);
}
```

---

## ctx.ai

AI operations — generate, extract, classify, and retrieve:

```typescript
interface AIService {
  generate(config: { prompt: string; input: Record<string, unknown> }): Promise<unknown>;
  extract(config: { schema: z.ZodTypeAny; text: string }): Promise<unknown>;
  classify(config: { labels: string[]; text: string }): Promise<string[]>;
  retrieve(config: { query: string }): Promise<AIDocument[]>;
}
```

```typescript
handler: async (ctx, input) => {
  // Structured generation
  const analysis = await ctx.ai.generate({
    prompt: "analyzeTicket",
    input: { text: input.body },
  });

  // Extract structured data
  const entities = await ctx.ai.extract({
    text: input.description,
    schema: z.object({
      product: z.string(),
      quantity: z.number(),
    }),
  });

  // Classify
  const [label] = await ctx.ai.classify({
    text: input.message,
    labels: ["billing", "technical", "general"],
  });

  // RAG retrieval
  const docs = await ctx.ai.retrieve({
    query: input.question,
  });
}
```

---

## ctx.audit

Record audit trail entries:

```typescript
interface AuditService {
  record(entry: AuditEntry): void;
  flush(): Promise<void>;
  getRecords(): AuditEntry[];
}
```

Audit recording is typically handled automatically by the framework based on capability `audit` configuration. Manual recording:

```typescript
handler: async (ctx, input) => {
  ctx.audit.record({
    action: "manual.override",
    actor: ctx.auth.userId!,
    target: input.resourceId,
    metadata: { reason: input.reason },
  });
}
```

---

## ctx.errors

Factory for structured error responses:

```typescript
interface ErrorService {
  notFound(message: string): PlumbusError;
  forbidden(message: string): PlumbusError;
  conflict(message: string): PlumbusError;
  validation(message: string): PlumbusError;
  internal(message: string): PlumbusError;
}
```

```typescript
handler: async (ctx, input) => {
  const user = await ctx.data.User.findById(input.userId);
  if (!user) throw ctx.errors.notFound("User not found");

  if (!ctx.security.hasRole("admin")) {
    throw ctx.errors.forbidden("Admin access required");
  }
}
```

Each error maps to an HTTP status:
| Method | HTTP Status |
|--------|-------------|
| `notFound()` | 404 |
| `forbidden()` | 403 |
| `conflict()` | 409 |
| `validation()` | 400 |
| `internal()` | 500 |

---

## ctx.logger

Structured logging with metadata:

```typescript
interface LoggerService {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}
```

```typescript
handler: async (ctx, input) => {
  ctx.logger.info("Processing order", { orderId: input.orderId });
  ctx.logger.warn("Inventory low", { productId: input.productId, remaining: 2 });
  ctx.logger.error("Payment failed", { error: err.message });
}
```

Fields marked with `maskedInLogs: true` in entity definitions are automatically redacted.

---

## ctx.security

Authorization helper methods:

```typescript
interface SecurityService {
  hasRole(role: string): boolean;
  hasScope(scope: string): boolean;
  hasAllRoles(roles: string[]): boolean;
  hasAllScopes(scopes: string[]): boolean;
  requireRole(role: string): void;    // throws if missing
  requireScope(scope: string): void;  // throws if missing
}
```

```typescript
handler: async (ctx, input) => {
  // Check
  if (ctx.security.hasRole("admin")) {
    // admin-specific logic
  }

  // Guard (throws 403 if missing)
  ctx.security.requireScope("billing:write");
}
```

---

## ctx.time

Clock abstraction for testability:

```typescript
interface TimeService {
  now(): Date;
}
```

Always use `ctx.time.now()` instead of `new Date()` to make capabilities testable with fixed time.

---

## ctx.config

Application configuration:

```typescript
type ConfigService = Record<string, unknown>;
```

---

## Flow-Specific Context

Inside flow step handlers, additional properties are available:

```typescript
handler: async (ctx, input) => {
  ctx.state;   // Current flow state
  ctx.step;    // Current step name
  ctx.flowId;  // Flow execution ID
}
```

---

## Creating Context

### Production

```typescript
import { createExecutionContext } from "plumbus-core";

const ctx = createExecutionContext({
  auth: authContext,
  data: dataService,
  events: eventService,
  flows: flowService,
  ai: aiService,
  audit: auditService,
  logger: loggerService,
  time: { now: () => new Date() },
  config: appConfig,
});
```

### Testing

```typescript
import { createTestContext } from "plumbus-core/testing";

const ctx = createTestContext({
  auth: { userId: "user-1", roles: ["admin"], tenantId: "t-1" },
  data: { User: [{ id: "user-1", name: "Alice" }] },
});
```

See the [Testing Guide](../testing/testing-guide.md) for full details.

