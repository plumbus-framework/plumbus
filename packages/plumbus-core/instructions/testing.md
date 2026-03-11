# Testing

Plumbus provides test utilities for testing capabilities, flows, and AI interactions in isolation.

## Test Utilities

Import from `plumbus-core/testing`:

```ts
import { runCapability, simulateFlow, mockAI, createTestContext } from "plumbus-core/testing";
```

### `runCapability`

Execute a capability in an isolated test environment:

```ts
const result = await runCapability("getUser", {
  input: { userId: "usr_123" },
  auth: { userId: "admin_1", roles: ["admin"], scopes: [], provider: "test" },
  data: {
    User: [{ id: "usr_123", name: "Alice", email: "alice@test.com" }],
  },
});

expect(result.name).toBe("Alice");
```

### `simulateFlow`

Simulate flow execution and inspect step history:

```ts
const execution = await simulateFlow("refundApproval", {
  input: { refundId: "rf_1", amount: 50 },
  events: {
    "refund.approved": { refundId: "rf_1", approvedBy: "mgr_1" },
  },
});

expect(execution.status).toBe("completed");
expect(execution.steps).toHaveLength(4);
expect(execution.steps[0].name).toBe("validateRefund");
```

### `mockAI`

Mock AI provider responses:

```ts
const ctx = createTestContext({
  ai: mockAI({
    summarizeTicket: { summary: "Customer wants refund", priority: "high", sentiment: "negative" },
  }),
});

const result = await ctx.ai.generate({ prompt: "summarizeTicket", input: { ticketText: "..." } });
expect(result.priority).toBe("high");
```

### `createTestContext`

Build a test `ctx` with controllable mocks:

```ts
const ctx = createTestContext({
  auth: { userId: "usr_1", roles: ["admin"], scopes: ["users:read"], provider: "test" },
  data: {
    User: [{ id: "usr_1", name: "Alice" }],
    Order: [],
  },
});
```

## Security Test Patterns

```ts
// Assert unauthorized access is rejected
await expect(
  runCapability("deleteUser", {
    input: { userId: "usr_1" },
    auth: { roles: ["viewer"], scopes: [], provider: "test" },
  })
).rejects.toMatchObject({ code: "forbidden" });

// Assert cross-tenant access is blocked
await expect(
  runCapability("getUser", {
    input: { userId: "usr_1" },
    auth: { tenantId: "other_tenant", roles: ["admin"], scopes: [], provider: "test" },
  })
).rejects.toMatchObject({ code: "forbidden" });
```

## Governance Test Patterns

```ts
import { verifyGovernance } from "plumbus-core/testing";

const signals = await verifyGovernance();
const highSeverity = signals.filter(s => s.severity === "high");
expect(highSeverity).toHaveLength(0);
```

## Test File Location

Place tests alongside their source:

```
app/capabilities/users/getUser/
  capability.ts
  impl.ts
  tests/
    getUser.test.ts
    fixtures/
```
