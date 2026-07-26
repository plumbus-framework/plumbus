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
  translations: TranslationService; // i18n catalog
  capabilities: CapabilityService; // Nested capability invocation (handlers only)
  request?: RequestMeta;       // HTTP metadata (HTTP callers only)
  state?: unknown;             // Flow state (flows only)
  step?: string;               // Current step (flows only)
  flowId?: string;             // Flow execution ID (flows only)
  workerId?: string;           // Owning worker identity (flows only)
  signal?: AbortSignal;        // Cancellation signal (flows only)
  progress?: ProgressService;  // MCP task progress (MCP task path only)
}
```

| Property | Description |
|----------|-------------|
| `ctx.progress` | Present only when running under an MCP task. Capability handlers call `ctx.progress?.report({ progress, total?, message? })` to emit `notifications/progress` to the connected MCP client. `undefined` outside MCP task context. |
| `ctx.capabilities` | Present in capability handlers and other framework-managed server contexts with a wired capability registry. **Not** for UI/client code. |
| `ctx.translations` | Locale-aware `t(key)` helper backed by registered translation catalogs. |

---

## ctx.capabilities

Invoke another capability synchronously through the full execution pipeline. Targets must be declared in the caller's `effects.capabilities` using canonical names (`<domain>.<capabilityName>`).

```typescript
interface CapabilityService {
  invoke(name: RegisteredCapabilityName, input: unknown): Promise<unknown>;
}
```

```typescript
handler: async (ctx, input) => {
  const profile = await ctx.capabilities.invoke("users.getProfile", {
    userId: input.userId,
  });
  return { profile };
};
```

- Returns unwrapped output on success; throws structured `PlumbusError` on failure.
- Inherits caller auth, transaction scope, and correlation metadata.
- HTTP requests propagate `X-Correlation-Id` or `X-Request-Id` into `ctx.__runtime.correlationId` and audit metadata when present.
- Nested `ctx.events.emit()` calls set `causationId` to the invoking capability's canonical name.
- **Job** capabilities cannot be invoke targets — use job dispatch or flows.
- Do **not** import other capability modules, call `.handler` directly, or use internal `ctx.__runtime` invokers — handlers only get the policy-enforced `ctx.capabilities` surface.
- Flow steps should use flow `capability` step types rather than `ctx.capabilities.invoke` unless the runtime context explicitly supports it.
- Runtimes with a **dynamic** allowlist (e.g. `@plumbus/chat` tool calling) cannot use `ctx.capabilities.invoke` — it throws `undeclaredInvocation` because the target is not in a static `effects.capabilities`. They resolve via `ctx.__runtime.resolveCapability(name)` and call `executeCapability(cap, ctx, input)`, which still enforces the target's access policy (`evaluateAccess`).

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
  /** Bulk-create N records in a single DB round-trip plus one summary audit row. */
  createMany(records: Partial<T>[]): Promise<T[]>;
  update(id: string, updates: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  findMany(query?: Partial<T>, options?: QueryOptions): Promise<T[]>;
  count(
    query?: Partial<T>,
    options?: Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'>,
  ): Promise<number>;
  aggregate(query?: Partial<T>, options?: AggregateOptions): Promise<AggregateRow[]>;
}
```

Use `createMany` for hot paths that would otherwise call `create()` in a loop (typically more than ~10 records). Use `aggregate` when you need `SUM` / `AVG` / `MIN` / `MAX` / `COUNT` / `COUNT(DISTINCT)` in the database instead of loading rows to reduce in memory — filtering matches `findMany`/`count`, and tenant scoping, soft-delete, and encrypted-field guards all apply. See [Data layer — aggregate](data-layer.md#aggregatequery-options) for options and result shape. Empty arrays short-circuit to `[]` without touching the database. Tenant scoping and audit behave as for `create()` — a single summary audit row is recorded per batch instead of one per record.

### Type Safety via PlumbusRegistry

After running `plumbus generate`, `ctx.data` is strictly typed — only entities you've defined are accessible. The generated `.plumbus/generated/plumbus.d.ts` augments the `PlumbusRegistry` interface, so:

- `ctx.data.User` autocompletes with `Repository<UserRecord, UserCreateInput, UserUpdateInput>` methods
- `ctx.data.NonExistent` produces a TypeScript error

Before generation (or without it), `ctx.data` falls back to `Record<string, Repository>`, allowing any string key for backward compatibility.

The same pattern applies to:
- **`ctx.events.emit(eventName, payload)`** — `eventName` is typed to registered event names, and `payload` is typed to the corresponding event's payload schema
- **`ctx.flows.start(flowName)`** — `flowName` is typed to registered flow names
- **Flow step `capability`** — typed to registered capability names
- **Flow trigger/wait/emit `event`** — typed to registered event names

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
  emit<E extends RegisteredEventName>(
    eventName: E,
    payload: RegisteredEventPayloadMap[E],
  ): Promise<void>;

  /** Bulk-emit N events of the same name in a single outbox INSERT plus one summary audit row. */
  emitMany<E extends RegisteredEventName>(
    events: Array<{ eventName: E; payload: RegisteredEventPayloadMap[E] }>,
  ): Promise<void>;
}
```

All events in a single `emitMany` call must share the same event name so TypeScript can enforce the payload shape. Empty arrays short-circuit without touching the database.

After running `plumbus generate`, both the event name and payload are strictly typed:

```typescript
// OK — "order.placed" is registered and payload matches its schema
await ctx.events.emit("order.placed", {
  orderId: input.orderId,
  total: input.total,
});

// Type error — wrong payload shape for "order.placed"
await ctx.events.emit("order.placed", { wrong: "field" });
```

Before generation, both fall back to `string` and `unknown` for backward compatibility.

---

## ctx.flows

Start, resume, cancel, and check flow executions:

```typescript
interface FlowService {
  start(flowName: string, input: unknown): Promise<FlowExecution>;
  resume(executionId: string, signal?: unknown): Promise<void>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<FlowExecution>;
  /** Extend the current flow execution lease. Only effective inside a flow step handler. */
  heartbeat(): Promise<void>;
  /** Describe a registered flow — name, domain, description, and input schema. */
  describe?(flowName: string): FlowDescription | undefined;
}

interface FlowDescription {
  name: string;
  domain: string;
  description?: string;
  inputSchema: unknown;
  parameters?: unknown;
}
```

`describe(flowName)` returns the registered flow's contract, or `undefined` when the
name is unknown. It is optional on the interface, so probe before calling. Its purpose
is to expose a flow to a model as a callable tool: `@plumbus/chat` uses it to bind
`policy.toolCalling.autoStartFlows` entries into provider-native tool definitions,
deriving each tool's JSON schema from `inputSchema`. Application code rarely needs it —
prefer `start` / `status` / `resume` / `cancel`.

`cancel(executionId)` is now cooperative — it aborts the running step's `AbortController` (the same signal exposed as `ctx.signal` inside the step). See [Cancellation](../core-concepts/flows.md#cancellation) in the flow docs for how to thread `ctx.signal` into in-flight AI / HTTP calls.

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
  generate(config: GenerateConfig): Promise<unknown>;
  // No tools → flat AIFinalGenerateResult (`.data` unconditional).
  // Tools enabled → AIToolEnabledGenerateResult discriminated union (keyed on finishReason).
  generateWithUsage(config: GenerateConfig): Promise<AIFinalGenerateResult>;
  generateWithUsage(config: GenerateConfig & { tools: AITool[] }): Promise<AIToolEnabledGenerateResult>;
  streamGenerate(config: StreamConfig): AsyncIterable<AIStreamEvent>;
  extract(config: ExtractConfig): Promise<unknown>;
  classify(config: ClassifyConfig): Promise<string[]>;
  retrieve(config: {
    query: string;
    corpus?: string;
    filter?: Record<string, unknown>;
    limit?: number;
    minScore?: number;
    signal?: AbortSignal;
  }): Promise<AIDocument[]>;
  recordProviderCost(entry: AICostRecord, costContext?: AICostContext): Promise<void>;
  checkProviderCostBudget(config?: BudgetCheckConfig): Promise<BudgetCheckResult>;
}

// All AI calls accept these optional fields:
//   messages?: ChatMessage[]            // native multi-turn (generate/stream)
//   validation?: AIValidationOptions    // per-call retry override
//   signal?: AbortSignal                // defaults to ctx.signal inside flows
//   costContext?: AICostContext         // per-call billing metadata
//   seed?: number                       // deterministic sampling (OpenAI-compatible)
//   tools?: AITool[]                     // provider-native tool calling (generate/generateWithUsage)
//   toolChoice?: AIToolChoice            // 'auto' | 'none' | { type:'function'; function:{ name } }
//   toolExecution?: { parallelToolCalls?: boolean }
//   outputValidation?: 'prompt' | 'none' // 'none' disables output-schema validation

// AIGenerateResult is the flat, back-compatible alias of AIFinalGenerateResult:
interface AIFinalGenerateResult<T = Record<string, any>> {
  finishReason?: 'stop' | 'length' | 'refusal' | 'other'; // OPTIONAL in the type so pre-0.6.9
                                                          // result literals (mocks, custom AIService
                                                          // impls) still compile. The framework
                                                          // always sets it; readers should narrow.
  data: T;                 // always present on the flat/no-tool result
  usage: AITokenUsage;
  model: string;
  provider: string;
  cost: number;
}
type AIGenerateResult<T = Record<string, any>> = AIFinalGenerateResult<T>;

interface AITokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens served from provider cache (charged at 0.1x input rate) */
  cachedInputTokens?: number;
  /** Tokens written to provider cache (charged at 1.25x input rate) */
  cacheWriteTokens?: number;
}
```

Provider-cost helpers are also documented in [AI integration](../ai/ai-integration.md) and [Voice cost tracking](../voice/cost-tracking.md).

```typescript
handler: async (ctx, input) => {
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

  // Generate with token usage (for accurate cost tracking)
  const { data, usage } = await ctx.ai.generateWithUsage({
    prompt: "analyzeTicket",
    input: { text: input.body },
  });
  // usage = { inputTokens, outputTokens, totalTokens }
}
```

---

## ctx.audit

Record audit trail entries:

```typescript
interface AuditService {
  record(eventType: string, metadata?: Record<string, unknown>): Promise<void>;
}
```

Audit recording is typically handled automatically by the framework based on capability `audit` configuration. Manual recording:

```typescript
handler: async (ctx, input) => {
  await ctx.audit.record("manual.override", {
    reason: input.reason,
    resourceId: input.resourceId,
    actorId: ctx.auth.userId,
  });
}
```

---

## ctx.errors

Factory for structured error responses:

```typescript
interface ErrorService {
  notFound(message: string, metadata?: Record<string, unknown>): PlumbusError;
  forbidden(message: string, metadata?: Record<string, unknown>): PlumbusError;
  conflict(message: string, metadata?: Record<string, unknown>): PlumbusError;
  validation(message: string, metadata?: Record<string, unknown>): PlumbusError;
  internal(message: string, metadata?: Record<string, unknown>): PlumbusError;
  dependencyViolation(message: string, metadata?: Record<string, unknown>): PlumbusError;
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
| `dependencyViolation()` | 400 |

---

## ctx.logger

Structured logging with metadata:

```typescript
interface LoggerService {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}
```

```typescript
handler: async (ctx, input) => {
  ctx.logger.debug("Entering handler", { orderId: input.orderId });
  ctx.logger.info("Processing order", { orderId: input.orderId });
  ctx.logger.warn("Inventory low", { productId: input.productId, remaining: 2 });
  ctx.logger.error("Payment failed", { error: err.message });
}
```

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

## ctx.request

HTTP request metadata (available in HTTP-triggered capabilities):

```typescript
interface RequestMeta {
  sourceIp?: string;
  userAgent?: string;
}
```

```typescript
handler: async (ctx, input) => {
  // Access request metadata for audit logging
  const ip = ctx.request?.sourceIp;
  const ua = ctx.request?.userAgent;
}
```

Automatically populated by the route generator from Fastify request headers. Not available in test contexts unless explicitly provided.

> **Proxy deployments**: If your app sits behind a reverse proxy or load balancer, set `trustProxy` in `ServerConfig` so that `sourceIp` reflects the client's real IP from `X-Forwarded-For` rather than the proxy's address.

---

## ctx.config

Application configuration:

```typescript
type ConfigService = RegisteredAppConfig;
```

By default, `ConfigService` is `Record<string, unknown>`. When you augment `PlumbusRegistry` with an `appConfig` field, `ctx.config` becomes strictly typed to your app's configuration shape:

```typescript
// In your generated plumbus.d.ts or manual augmentation:
declare module "@plumbus/core" {
  interface PlumbusRegistry {
    appConfig: {
      featureFlags: { newCheckout: boolean };
      limits: { maxUploadMb: number };
    };
  }
}
```

```typescript
handler: async (ctx, input) => {
  // Fully typed — no need for type assertions
  const enabled = ctx.config.featureFlags.newCheckout;
}
```

> **Note:** `ConfigService` is distinct from `PlumbusConfig` (framework infrastructure config). `ctx.config` exposes only app-level configuration — never database credentials, queue passwords, or API keys.

---

## Flow-Specific Context

Inside flow step handlers, additional properties are available:

```typescript
handler: async (ctx, input) => {
  ctx.state;     // Current flow state
  ctx.step;      // Current step name
  ctx.flowId;    // Flow execution ID
  ctx.workerId;  // Owning worker (matches lease_owner on flow_executions)
  ctx.signal;    // Cancellation signal — fires on flows.cancel() or lease loss
}
```

Pass `ctx.signal` to cancelable AI/HTTP calls so cancellation propagates without leaving zombie work running. Most `ctx.ai.*` methods default their `signal` parameter to `ctx.signal` automatically; explicit threading is only needed for raw `fetch()` or third-party SDK calls. See [Cancellation](../core-concepts/flows.md#cancellation) for the full pattern.

---

## Creating Context

### Production

```typescript
import { createExecutionContext } from "@plumbus/core";

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
import { createTestContext } from "@plumbus/core/testing";

const ctx = createTestContext({
  auth: { userId: "user-1", roles: ["admin"], tenantId: "t-1" },
  data: { User: [{ id: "user-1", name: "Alice" }] },
});
```

See the [Testing Guide](../testing/testing-guide.md) for full details.

