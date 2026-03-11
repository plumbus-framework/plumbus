// ── Test Scaffolding Generator ──
// Generates test files for capabilities, flows, entities, and events
// that use the plumbus-core/testing utilities.

import { toCamelCase, toPascalCase } from "../cli/utils.js";

/**
 * Generate a capability test file using the testing framework.
 */
export function generateCapabilityTest(
  name: string,
  _domain: string,
  _kind: string = "action",
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
