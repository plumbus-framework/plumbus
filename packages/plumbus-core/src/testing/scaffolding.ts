// ── Test Scaffolding Generator ──
// Generates test files for capabilities, flows, entities, and events
// that use the plumbus-core/testing utilities.

import { toCamelCase, toPascalCase } from '../cli/utils.js';

/**
 * Generate a capability test file using the testing framework.
 */
export function generateCapabilityTest(
  name: string,
  _domain: string,
  _kind: string = 'action',
): string {
  const pascal = toPascalCase(name);
  const camel = toCamelCase(name);
  return `import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  runCapability,
  createTestContext,
  createTestAuth,
  mockAI,
} from "plumbus-core/testing";
import { ${camel} } from "../capability.js";

describe("${pascal}", () => {
  it("executes successfully with valid input", async () => {
    const result = await runCapability(${camel}, {
      // TODO: provide valid input
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid input", async () => {
    const result = await runCapability(${camel}, {
      // TODO: provide invalid input
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("validation");
    }
  });

  it("denies access to unauthorized users", async () => {
    const result = await runCapability(${camel}, {
      // TODO: provide valid input
    }, {
      auth: { roles: [] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("forbidden");
    }
  });

  it("allows access for authorized roles", async () => {
    const result = await runCapability(${camel}, {
      // TODO: provide valid input
    }, {
      auth: { roles: ["admin"] },
    });
    // Should not get a forbidden error
    if (!result.success) {
      expect(result.error.code).not.toBe("forbidden");
    }
  });
});
`;
}

/**
 * Generate a flow test file using the testing framework.
 */
export function generateFlowTest(name: string, _domain: string): string {
  const pascal = toPascalCase(name);
  const camel = toCamelCase(name);
  return `import { describe, it, expect } from "vitest";
import { simulateFlow } from "plumbus-core/testing";
import { ${camel}Flow } from "../flow.js";

describe("${pascal} Flow", () => {
  it("completes all steps successfully", async () => {
    const result = await simulateFlow(${camel}Flow, {
      // TODO: provide valid flow input
    });
    expect(result.status).toBe("completed");
    expect(result.history.length).toBeGreaterThan(0);
  });

  it("tracks step execution history", async () => {
    const result = await simulateFlow(${camel}Flow, {
      // TODO: provide valid flow input
    });
    for (const entry of result.history) {
      expect(entry.step).toBeDefined();
      expect(entry.status).toBeDefined();
    }
  });

  it("handles capability step failure", async () => {
    const result = await simulateFlow(${camel}Flow, {
      // TODO: provide valid flow input
    }, {
      capabilityResults: {
        // TODO: map step name → failure result
        // "processOrder": { success: false, error: "processing failed" },
      },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });
});
`;
}

/**
 * Generate a security test file for a capability.
 */
export function generateSecurityTest(name: string, _domain: string): string {
  const pascal = toPascalCase(name);
  const camel = toCamelCase(name);
  return `import { describe, it, expect } from "vitest";
import {
  assertCapabilityDenied,
  assertCapabilityAllowed,
  assertTenantIsolation,
  unauthenticated,
  adminAuth,
} from "plumbus-core/testing";
import { ${camel} } from "../capability.js";

describe("${pascal} Security", () => {
  const validInput = {
    // TODO: provide valid input
  };

  it("denies unauthenticated access", async () => {
    await assertCapabilityDenied(${camel}, validInput, {
      auth: { roles: [], userId: undefined },
    });
  });

  it("allows admin access", async () => {
    await assertCapabilityAllowed(${camel}, validInput, {
      auth: { roles: ["admin"], tenantId: "tenant-1" },
    });
  });

  it("enforces tenant isolation", async () => {
    const { sameTenantResult, crossTenantResult } = await assertTenantIsolation(
      ${camel}, validInput, "tenant-1",
    );
    // Verify same-tenant access pattern
    expect(sameTenantResult).toBeDefined();
    expect(crossTenantResult).toBeDefined();
  });
});
`;
}

/**
 * Generate a governance test file for a resource inventory.
 */
export function generateGovernanceTest(domain: string): string {
  const pascal = toPascalCase(domain);
  return `import { describe, it, expect } from "vitest";
import {
  evaluateGovernance,
  emptyInventory,
  assertGovernanceSignals,
  assertNoGovernanceSignal,
  assertPolicyCompliance,
} from "plumbus-core/testing";
import {
  securityRules,
  privacyRules,
  architectureRules,
} from "plumbus-core";

describe("${pascal} Governance", () => {
  // TODO: Import your capabilities, entities, etc.
  const inventory = emptyInventory({
    capabilities: [],
    entities: [],
  });

  it("passes security rules", () => {
    const result = evaluateGovernance(securityRules, inventory);
    assertNoGovernanceSignal(result, [
      "security.capability-missing-access-policy",
    ]);
  });

  it("passes privacy rules", () => {
    const result = evaluateGovernance(privacyRules, inventory);
    expect(result.effective.filter(s => s.severity === "high")).toHaveLength(0);
  });

  it("complies with internal security baseline", () => {
    assertPolicyCompliance(inventory, "internal_security_baseline");
  });
});
`;
}

// ── E2E Page Info ──

export interface E2EPageDescriptor {
  /** Route path, e.g. "/project" */
  route: string;
  /** Display name for the page */
  pageName: string;
  /** Action panels on this page — each has a title and field names */
  actions: E2EActionDescriptor[];
  /** Query panels that auto-fetch on load */
  queries?: E2EQueryDescriptor[];
}

export interface E2EActionDescriptor {
  /** Panel title as it appears in the UI */
  title: string;
  /** Submit button label */
  submitLabel: string;
  /** Field names in this panel's form */
  fields: string[];
}

export interface E2EQueryDescriptor {
  /** Panel title as it appears in the UI */
  title: string;
}

/**
 * Generate an E2E browser test file for a page in a Plumbus Next.js app.
 *
 * Uses vitest as the test runner with Playwright for browser automation.
 * Both come from the framework — no additional packages needed.
 */
export function generateE2ETest(page: E2EPageDescriptor): string {
  const actionTests = page.actions
    .map((action) => {
      const fieldFills = action.fields
        .map(
          (f) =>
            `      const ${f}Field = panel.locator(\`label:has-text("${f}") + input, [name="${f}"]\`).first();\n      if (await ${f}Field.count()) await ${f}Field.fill("test-value");`,
        )
        .join('\n');

      return `
    it("submits ${action.title}", async () => {
      const panel = page.locator("section.panel", { has: page.getByRole("heading", { name: ${JSON.stringify(action.title)} }) });
      await expect(panel.count()).resolves.toBeGreaterThan(0);

${fieldFills}

      await panel.getByRole("button", { name: ${JSON.stringify(action.submitLabel)} }).click();

      // Wait for the request to complete
      await page.waitForTimeout(2000);

      // Assert no error card appeared
      const errorCount = await panel.locator(".error-card").count();
      expect(errorCount).toBe(0);
    });`;
    })
    .join('\n');

  const queryTests = (page.queries ?? [])
    .map(
      (q) => `
    it("loads ${q.title} query panel", async () => {
      const panel = page.locator("article", { has: page.getByRole("heading", { name: ${JSON.stringify(q.title)} }) });
      await expect(panel.count()).resolves.toBeGreaterThan(0);
    });`,
    )
    .join('\n');

  const routeEscaped = page.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return `import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "plumbus-core/testing";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

describe("${page.pageName} page", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(BASE_URL + ${JSON.stringify(page.route)});
    await page.waitForLoadState("networkidle");
  }, 30_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it("renders the page", async () => {
    expect(page.url()).toMatch(/${routeEscaped}/);
    const main = await page.locator("main").count();
    expect(main).toBeGreaterThan(0);
  });
${actionTests}
${queryTests}
});
`;
}
