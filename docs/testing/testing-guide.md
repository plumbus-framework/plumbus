# Testing Guide

Plumbus provides a complete testing toolkit exported from `plumbus-core/testing`. Every testing utility is designed to work with Vitest.

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
} from "plumbus-core/testing";
```

## Testing Capabilities

### runCapability

Execute a capability in an isolated test context:

```typescript
import { runCapability } from "plumbus-core/testing";
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
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});
```

### RunCapabilityOptions

```typescript
interface RunCapabilityOptions {
  auth?: Partial<AuthContext>;
  data?: Record<string, Record<string, unknown>[]>;
  ai?: AIService;
  ctx?: ExecutionContext;  // Provide a full custom context
}
```

## Testing Flows

### simulateFlow

Simulate a flow execution step by step:

```typescript
import { simulateFlow } from "plumbus-core/testing";
import { orderFulfillment } from "../flows/orders/order-fulfillment/flow.js";

describe("orderFulfillment", () => {
  it("completes all steps when payment succeeds", async () => {
    const result = await simulateFlow(orderFulfillment, { orderId: "o-1" }, {
      auth: { roles: ["system"], tenantId: "t-1" },
      capabilityResults: {
        validateOrder: { success: true, data: { valid: true } },
        processPayment: { success: true, data: { paymentStatus: "success" } },
        createShipment: { success: true, data: { shipmentId: "s-1" } },
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
        validateOrder: { success: true },
        processPayment: { success: true, data: { paymentStatus: "failed" } },
        cancelOrder: { success: true },
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
} from "plumbus-core/testing";

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
    const { own, other } = await assertTenantIsolation(
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

    expect(own).toHaveLength(1);
    expect(other).toHaveLength(0);
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
} from "plumbus-core/testing";

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
  classifyTicket: {
    department: "billing",
    urgency: "high",
    confidence: 0.95,
  },
});
```

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

### createE2EServer

Boot a full Plumbus server for integration tests:

```typescript
import { createE2EServer, createTestBearerHeader } from "plumbus-core/testing";

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
} from "plumbus-core/testing";

const testCode = generateCapabilityTest("getUser", "users", "query");
const flowTest = generateFlowTest("orderFulfillment", "orders");
const secTest = generateSecurityTest("createOrder", "orders");
const govTest = generateGovernanceTest("orders");
```

## Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm vitest run path/to/test.test.ts

# Watch mode
pnpm vitest path/to/test.test.ts

# Coverage
pnpm vitest run --coverage
```

