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
import { evaluateGovernance } from "plumbus-core/testing";

const result = evaluateGovernance(rules, inventory);
const signals = result.signals;
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

## E2E Browser Tests

Plumbus provides vitest + Playwright end-to-end testing for generated Next.js frontends. Tests run in Node via vitest and control a real browser through Playwright — both provided by the framework, no additional packages needed.

### CLI Scaffolding

```bash
# Scan the frontend and generate E2E tests
plumbus ui e2e

# Custom output directory and base URL
plumbus ui e2e e2e-tests --frontend-dir frontend --base-url http://localhost:3001
```

This scans `frontend/app/**/page.tsx` for ActionPanel usage and generates:
- `vitest.config.e2e.ts` — vitest configuration for e2e tests
- `{page}.e2e.ts` — One test file per page, covering form submission and error assertions

### Manual E2E Test Writing

Import from `plumbus-core/testing`:

```ts
import { createE2EServer, createTestBearerHeader } from "plumbus-core/testing";
```

#### API-Level E2E

```ts
import { createE2EServer } from "plumbus-core/testing";

let e2e;
beforeAll(async () => {
  e2e = await createE2EServer({ capabilities: [myCapability] });
});
afterAll(async () => { await e2e.close(); });

it("responds to capability route", async () => {
  const res = await e2e.fetch("/api/my-capability", {
    method: "POST",
    body: JSON.stringify({ input: "test" }),
  });
  expect(res.ok).toBe(true);
});
```

#### Browser-Level E2E (vitest + Playwright)

Generated test files use vitest as the test runner with Playwright for browser automation:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "plumbus-core/testing";

describe("Project page", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto("http://localhost:3001/project");
    await page.waitForLoadState("networkidle");
  }, 30_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it("renders the page", async () => {
    const main = await page.locator("main").count();
    expect(main).toBeGreaterThan(0);
  });
});
```

The framework scaffolds page descriptors:

```ts
import { generateE2ETest, type E2EPageDescriptor } from "plumbus-core/testing";

const page: E2EPageDescriptor = {
  route: "/project",
  pageName: "Project",
  actions: [
    { title: "Open a new biography", submitLabel: "Create project", fields: ["title", "subjectName"] },
  ],
  queries: [{ title: "Budget and readiness" }],
};

const testCode = generateE2ETest(page);
```

### Running E2E Tests

```bash
# Install Playwright browsers (one-time, from framework)
cd node_modules/plumbus-core && npx playwright install chromium

# Run E2E tests
plumbus test --config frontend/e2e/vitest.config.e2e.ts
```

## Framework-Provided Dependencies — DO NOT Install Separately

The framework includes **vitest**, **zod**, and **playwright** as dependencies of `plumbus-core`. Consumer apps must **never** add these to their own `package.json`. Import them through the framework:

```ts
// Zod — use for schema definitions in prompts, events, etc.
import { z } from "plumbus-core/zod";

// Vitest — available at runtime when plumbus test runs tests
import { describe, it, expect } from "vitest";

// Vitest config — for vitest.config.ts files
import { defineConfig } from "plumbus-core/vitest";

// Playwright + test utilities — for e2e tests
import { chromium, type Browser, type Page } from "plumbus-core/testing";

// Test utilities — for unit/integration tests
import { runCapability, createTestContext, mockAI } from "plumbus-core/testing";
```

Run tests with `plumbus test` — not `vitest run` or `npx vitest`.
