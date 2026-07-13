# Testing Guide

Plumbus provides a complete testing toolkit exported from `@plumbus/core/testing`. Every testing utility is designed to work with Vitest.

**Important**: Vitest, Zod, and Playwright are all provided by the framework. Consumer apps must **not** install them separately. Run tests with `plumbus test` — never `vitest run` or `npx vitest`.

## Setup

```typescript
import { describe, it, expect } from "vitest";
import {
  createTestContext,
  runCapability,
  simulateFlow,
  mockAI,
  mockEvents,
  assertAccessDenied,
  assertCapabilityAllowed,
} from "@plumbus/core/testing";
```

## Testing Capabilities

### runCapability

Execute a capability in an isolated test context:

```typescript
import { runCapability } from "@plumbus/core/testing";
import { getUser } from "../capabilities/users/get-user/capability.js";

describe("getUser", () => {
  it("returns the user", async () => {
    const result = await runCapability(getUser, { userId: "u-1" }, {
      auth: { userId: "u-1", roles: ["user"], tenantId: "t-1" },
      data: {
        User: [{ id: "u-1", name: "Alice", tenantId: "t-1" }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data.name).toBe("Alice");
  });

  it("returns 404 for missing user", async () => {
    const result = await runCapability(getUser, { userId: "invalid" }, {
      auth: { userId: "u-1", roles: ["user"], tenantId: "t-1" },
      data: { User: [] },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("notFound");
  });
});
```

### RunCapabilityOptions

`RunCapabilityOptions` extends `TestContextOptions` — every service the test context creates can be overridden.

```typescript
interface RunCapabilityOptions {
  // Auth & data fixtures
  auth?: Partial<AuthContext>;
  data?: Record<string, Record<string, unknown>[]>;
  entities?: EntityDefinition[];          // Enable field-type validation on writes

  // Service overrides — substitute mocks or fakes
  ai?: AIService | AIResponse;            // Pass a pre-built service, or shorthand response
  events?: EventService;                  // Capture or assert event emissions
  flows?: FlowService;                    // Capture flow.start calls
  audit?: AuditService;                   // Capture audit writes
  logger?: LoggerService;                 // Quiet logs or assert log lines
  time?: TimeService | Date;              // Pin "now" for deterministic tests
  config?: Record<string, unknown>;       // Stub ctx.config

  // Capability registry for nested invoke
  capabilities?: CapabilityContract[];    // Wire ctx.capabilities.invoke in tests

  // Escape hatch
  ctx?: ExecutionContext;                 // Bypass everything above and provide a full custom context
}
```

Common uses:

- **`time: new Date("2024-01-15T12:00:00Z")`** — pin `ctx.time.now()` for snapshot stability.
- **`events: createMockEventService()`** — assert `ctx.events.emit` calls instead of letting them go to the outbox mock.
- **`ai: { generate: { text: "fixed reply" } }`** — shorthand for a one-shot `AIService` that always returns this response from `generate()`.

### Field-Type Validation

Pass entity definitions via the `entities` option to catch type mismatches at test time (e.g. inserting a float into an integer field):

```typescript
import { runCapability } from "@plumbus/core/testing";
import { timelineEventEntity } from "../entities/timeline-event.entity.js";
import { createTimelineEvent } from "../capabilities/default/create-timeline-event/capability.js";

const result = await runCapability(createTimelineEvent, input, {
  auth: { roles: ["user"] },
  entities: [timelineEventEntity],
  data: {
    ProjectMembership: [{ id: "mem_1", projectId: "proj_1", userId: "test-user", role: "owner" }],
  },
});
```

When `entities` is provided, the mock data store validates every `create()` and `update()` call against the entity's field descriptors. A `field.number()` column rejects non-integer values, `field.enum()` rejects invalid values, etc.

## Canonical capability names in tests

Registry lookups, `runCapability`, `simulateFlow` step overrides, and `ctx.capabilities.invoke` use **canonical names** (`<domain>.<capabilityName>`). Pass the capability definition object to `runCapability(getUser, …)` when possible; when using string keys (e.g. `capabilityResults`), use canonical names.

Register capabilities for nested invoke or production-like flow step execution:

```typescript
const ctx = createTestContext({
  capabilities: [getInvoice, chargeCard],
  auth: { roles: ["billing"], tenantId: "t-1" },
});

await ctx.capabilities.invoke("billing.getInvoice", { invoiceId: "inv_1" });
```

## Testing Flows

### simulateFlow

Simulate a flow execution step by step:

```typescript
import { simulateFlow } from "@plumbus/core/testing";
import { orderFulfillment } from "../flows/orders/order-fulfillment/flow.js";

describe("orderFulfillment", () => {
  it("completes all steps when payment succeeds", async () => {
    const result = await simulateFlow(orderFulfillment, { orderId: "o-1" }, {
      auth: { roles: ["admin"], tenantId: "t-1" },
      capabilityResults: {
        "orders.validateOrder": { success: true, data: { valid: true } },
        "billing.processPayment": { success: true, data: { paymentStatus: "success" } },
        "shipping.createShipment": { success: true, data: { shipmentId: "s-1" } },
      },
      conditionResults: {
        checkInventory: true,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.history).toHaveLength(5);
  });

  it("cancels order when payment fails", async () => {
    const result = await simulateFlow(orderFulfillment, { orderId: "o-1" }, {
      capabilityResults: {
        "orders.validateOrder": { success: true },
        "billing.processPayment": { success: true, data: { paymentStatus: "failed" } },
        "orders.cancelOrder": { success: true },
      },
      conditionResults: {
        checkInventory: false,
      },
    });

    expect(result.status).toBe("completed");
    const cancelStep = result.history.find(h => h.stepName === "cancelOrder");
    expect(cancelStep?.status).toBe("completed");
  });
});
```

### Job blocking in flow simulation

When you pass `capabilities` in `simulateFlow` options, the simulator uses the same job-blocking step executor as production. A flow step that references a `kind: 'job'` capability fails with `dependencyViolation` / `unsupportedTargetKind`:

```typescript
const result = await simulateFlow(reportFlow, {}, {
  capabilities: [generateReportJob],
  auth: { roles: ["admin"] },
});
expect(result.status).toBe("failed");
```

Use `capabilityResults` to stub step outputs without registering real handlers; use `capabilities` when you need real invoke behavior or production-like step execution.

### FlowSimulationResult

```typescript
interface FlowSimulationResult {
  status: FlowStatus;
  history: StepHistoryEntry[];
  state: unknown;
  stepResults: Map<string, StepResult>;
  error?: string;
}
```

## Testing Security

### Access Policy Testing

```typescript
import {
  assertAccessAllowed,
  assertAccessDenied,
  assertCapabilityDenied,
  assertCapabilityAllowed,
  assertTenantIsolation,
  unauthenticated,
  adminAuth,
  serviceAccountAuth,
} from "@plumbus/core/testing";

describe("security", () => {
  it("denies unauthenticated access", async () => {
    await assertCapabilityDenied(createOrder, orderInput, {
      auth: unauthenticated(),
    });
  });

  it("allows admin access", async () => {
    await assertCapabilityAllowed(createOrder, orderInput, {
      auth: adminAuth("tenant-1"),
    });
  });

  it("enforces tenant isolation", async () => {
    const { sameTenantResult, crossTenantResult } = await assertTenantIsolation(
      getOrders,
      {},
      "tenant-1",
      {
        data: {
          Order: [
            { id: "1", tenantId: "tenant-1" },
            { id: "2", tenantId: "tenant-2" },
          ],
        },
      },
    );

    expect(sameTenantResult.success).toBe(true);
    expect(crossTenantResult.success).toBe(false);
  });

  it("works with service accounts", async () => {
    await assertCapabilityAllowed(processEvent, eventPayload, {
      auth: serviceAccountAuth("event-worker"),
    });
  });
});
```

### Auth Helpers

| Helper | Returns |
|--------|---------|
| `unauthenticated()` | `AuthContext` with no roles/scopes |
| `adminAuth(tenantId?)` | `AuthContext` with admin role |
| `serviceAccountAuth(id)` | `AuthContext` for service account |
| `assertPlumbusError` / `assertValidationError` | Assert structured error codes on thrown errors |
| `createTestAuth` / `createTestData` | Build partial auth/data fixtures for `createTestContext` |
| `mockAudit` / `mockLogger` | Capture audit records and log lines in tests |

## Testing Governance

```typescript
import {
  evaluateGovernance,
  assertGovernanceSignals,
  assertNoGovernanceSignal,
  assertMaxSeverity,
  assertPolicyCompliance,
  assertPolicyNonCompliance,
  emptyInventory,
} from "@plumbus/core/testing";

describe("governance", () => {
  it("flags missing field classification", () => {
    const inventory = emptyInventory({
      entities: [unclassifiedEntity],
    });

    const result = evaluateGovernance(
      [ruleMissingFieldClassification],
      inventory,
    );

    assertGovernanceSignals(result, ["missing-field-classification"]);
  });

  it("passes SOC2 compliance", () => {
    assertPolicyCompliance(fullInventory, "SOC2");
  });

  it("fails HIPAA without encryption", () => {
    assertPolicyNonCompliance(inventoryWithoutEncryption, "HIPAA");
  });

  it("has no critical severity issues", () => {
    const result = evaluateGovernance(allRules, inventory);
    assertMaxSeverity(result, "warning");
  });
});
```

## Mock Utilities

### createTestContext

Build a full `ExecutionContext` with in-memory mocks:

```typescript
const ctx = createTestContext({
  auth: {
    userId: "u-1",
    roles: ["admin"],
    scopes: ["users:write"],
    tenantId: "t-1",
  },
  data: {
    User: [{ id: "u-1", name: "Alice" }],
    Order: [],
  },
});
```

### mockAI

Provide predetermined AI responses:

```typescript
const ai = mockAI({
  generate: {
    department: "billing",
    urgency: "high",
    confidence: 0.95,
  },
});
```

Both `generate()` and `generateWithUsage()` use the same `generate` response key. `generateWithUsage()` wraps the response in `{ data, usage }` automatically, with estimated token counts derived from the config/response string lengths (~4 chars per token).

### mockEvents

Track emitted events:

```typescript
const events = mockEvents();
// ... run capability that emits events ...
expect(events.emitted).toContainEqual({
  eventName: "order.placed",
  payload: expect.objectContaining({ orderId: "o-1" }),
});
```

### mockFlows

Track flow operations:

```typescript
const flows = mockFlows();
// ... run capability ...
expect(flows.started).toContainEqual({
  flowName: "orderFulfillment",
  input: expect.objectContaining({ orderId: "o-1" }),
});
```

### fixedTime

Deterministic clock:

```typescript
const time = fixedTime(new Date("2025-01-01T00:00:00Z"));
expect(time.now()).toEqual(new Date("2025-01-01T00:00:00Z"));
```

### createInMemoryRepository

In-memory repository for unit tests:

```typescript
const repo = createInMemoryRepository([
  { id: "u-1", name: "Alice" },
  { id: "u-2", name: "Bob" },
]);

const user = await repo.findById("u-1");
expect(user?.name).toBe("Alice");
```

## E2E Testing

For generated browser configs, prefer an import-free `vitest.config.e2e.ts` that exports a plain object. This keeps consumer apps runnable through the framework wrapper without requiring a direct `vitest` install just to resolve `vitest/config` from the app workspace.

### createE2EServer

Boot a full Plumbus server for integration tests:

```typescript
import { createE2EServer, createTestBearerHeader } from "@plumbus/core/testing";

describe("API E2E", () => {
  let e2e: E2EServerContext;

  beforeAll(async () => {
    e2e = await createE2EServer({
      capabilities: [getUser, createUser],
      entities: [User],
    });
  });

  afterAll(async () => {
    await e2e.close();
  });

  it("GET /api/users/get-user", async () => {
    const res = await e2e.fetch("/api/users/get-user?userId=u-1", {
      headers: createTestBearerHeader({ roles: ["user"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Alice");
  });
});
```

### Testing MCP capabilities

```ts
import { createTestMcpServer } from '@plumbus/mcp/testing';
import { mcpTaskEntity } from '@plumbus/mcp';
import { myJobCapability } from '../app/capabilities/my-job/capability.js';

const { client, close } = await createTestMcpServer({
  capabilities: [myJobCapability],
  entities: [mcpTaskEntity],
  auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'mcp' },
});

try {
  const result = await client.callTool({
    name: 'myJobCapability',
    arguments: { ... },
    _meta: { taskMetadata: {} },
  } as any);
  // ... assert on result.task.taskId, poll tasks/get, etc.
} finally {
  await close();
}
```

See [packages/mcp/README.md](../../packages/mcp/README.md) for the full testing API.

## Scaffolding Test Files

Generate test boilerplate from CLI:

```bash
plumbus capability new getUser --kind query --domain users
# Creates capability.ts AND tests/get-user.test.ts

plumbus flow new orderFulfillment --domain orders
# Creates flow.ts AND tests/order-fulfillment.test.ts
```

Or programmatically:

```typescript
import {
  generateCapabilityTest,
  generateFlowTest,
  generateSecurityTest,
  generateGovernanceTest,
} from "@plumbus/core/testing";

const testCode = generateCapabilityTest("getUser", "users", "query");
const flowTest = generateFlowTest("orderFulfillment", "orders");
const secTest = generateSecurityTest("createOrder", "orders");
const govTest = generateGovernanceTest("orders");
```

## Running Tests

```bash
# Run all tests
pnpm test

# Run browser E2E from a consumer app with an already running frontend
plumbus test --config frontend/e2e/vitest.config.e2e.ts

# Let the framework manage the frontend server lifecycle for browser E2E
plumbus e2e

# Run specific test file
plumbus test path/to/test.test.ts

# Watch mode
plumbus test --watch

# Coverage (when supported by your vitest config)
plumbus test --coverage
```

