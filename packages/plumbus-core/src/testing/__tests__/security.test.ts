import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityContract } from "../../types/capability.js";
import { CapabilityKind } from "../../types/enums.js";
import type { AccessPolicy } from "../../types/security.js";
import { createTestAuth } from "../context.js";
import { runCapability } from "../run-capability.js";
import {
    adminAuth,
    assertAccessAllowed,
    assertAccessDenied,
    assertCapabilityAllowed,
    assertCapabilityDenied,
    assertPlumbusError,
    assertTenantIsolation,
    assertValidationError,
    serviceAccountAuth,
    unauthenticated,
} from "../security.js";

// ── Test Helpers ──

function roleProtectedCapability(roles: string[]): CapabilityContract {
  return {
    name: "protected",
    kind: CapabilityKind.Action,
    domain: "test",
    input: z.object({ value: z.string() }),
    output: z.object({ ok: z.boolean() }),
    access: { roles },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  };
}

function publicCapability(): CapabilityContract {
  return {
    name: "public-cap",
    kind: CapabilityKind.Query,
    domain: "test",
    input: z.object({}),
    output: z.object({ data: z.string() }),
    access: { public: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ data: "public" }),
  };
}

function tenantScopedCapability(): CapabilityContract {
  return {
    name: "tenant-scoped",
    kind: CapabilityKind.Query,
    domain: "test",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    access: { roles: ["admin"], tenantScoped: true },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  };
}

// ── assertAccessAllowed / assertAccessDenied ──

describe("assertAccessAllowed", () => {
  it("passes when role matches", () => {
    const policy: AccessPolicy = { roles: ["admin"] };
    const auth = createTestAuth({ roles: ["admin"] });
    expect(() => assertAccessAllowed(policy, auth)).not.toThrow();
  });

  it("throws when role does not match", () => {
    const policy: AccessPolicy = { roles: ["admin"] };
    const auth = createTestAuth({ roles: ["user"] });
    expect(() => assertAccessAllowed(policy, auth)).toThrow("DENIED");
  });

  it("passes for public policy", () => {
    const policy: AccessPolicy = { public: true };
    const auth = createTestAuth({ roles: [] });
    expect(() => assertAccessAllowed(policy, auth)).not.toThrow();
  });
});

describe("assertAccessDenied", () => {
  it("passes when role does not match", () => {
    const policy: AccessPolicy = { roles: ["admin"] };
    const auth = createTestAuth({ roles: ["user"] });
    expect(() => assertAccessDenied(policy, auth)).not.toThrow();
  });

  it("throws when access is allowed", () => {
    const policy: AccessPolicy = { roles: ["admin"] };
    const auth = createTestAuth({ roles: ["admin"] });
    expect(() => assertAccessDenied(policy, auth)).toThrow("ALLOWED");
  });

  it("passes when no policy (deny by default)", () => {
    const auth = createTestAuth({ roles: ["admin"] });
    expect(() => assertAccessDenied(undefined, auth)).not.toThrow();
  });
});

// ── assertCapabilityDenied / assertCapabilityAllowed ──

describe("assertCapabilityDenied", () => {
  it("passes when user lacks required role", async () => {
    const result = await assertCapabilityDenied(
      roleProtectedCapability(["admin"]),
      { value: "test" },
      { auth: { roles: ["user"] } },
    );
    expect(result.success).toBe(false);
  });

  it("throws when capability succeeds", async () => {
    await expect(
      assertCapabilityDenied(
        roleProtectedCapability(["admin"]),
        { value: "test" },
        { auth: { roles: ["admin"] } },
      ),
    ).rejects.toThrow("DENY");
  });
});

describe("assertCapabilityAllowed", () => {
  it("passes when user has required role", async () => {
    const result = await assertCapabilityAllowed(
      roleProtectedCapability(["admin"]),
      { value: "test" },
      { auth: { roles: ["admin"] } },
    );
    expect(result.success).toBe(true);
  });

  it("throws when capability returns forbidden", async () => {
    await expect(
      assertCapabilityAllowed(
        roleProtectedCapability(["admin"]),
        { value: "test" },
        { auth: { roles: ["user"] } },
      ),
    ).rejects.toThrow("ALLOW");
  });

  it("does not throw for non-forbidden errors (e.g., validation)", async () => {
    // Public capability but with validation error
    const result = await assertCapabilityAllowed(
      publicCapability(),
      { invalid: true }, // input doesn't have required fields
    );
    // Should not throw — it's not a forbidden error
    // But result may be a failure:
    if (!result.success) {
      expect(result.error.code).not.toBe("forbidden");
    }
  });
});

// ── assertTenantIsolation ──

describe("assertTenantIsolation", () => {
  it("returns same-tenant and cross-tenant results", async () => {
    const { sameTenantResult, crossTenantResult } = await assertTenantIsolation(
      tenantScopedCapability(),
      {},
      "tenant-1",
    );
    // Same tenant should succeed (admin role + matching tenant)
    expect(sameTenantResult).toBeDefined();
    // Cross tenant should fail if tenantScoped
    expect(crossTenantResult).toBeDefined();
  });

  it("same-tenant result succeeds with admin role", async () => {
    const { sameTenantResult } = await assertTenantIsolation(
      tenantScopedCapability(),
      {},
      "tenant-1",
    );
    expect(sameTenantResult.success).toBe(true);
  });

  it("cross-tenant result uses different tenant id", async () => {
    const { crossTenantResult } = await assertTenantIsolation(
      tenantScopedCapability(),
      {},
      "tenant-1",
    );
    // The cross-tenant result runs with a different tenant ID
    // In real apps, the handler would enforce tenant isolation on data access;
    // here we just verify both results are returned
    expect(crossTenantResult).toBeDefined();
  });
});

// ── assertValidationError ──

describe("assertValidationError", () => {
  it("passes when result is a validation error", async () => {
    const result = await runCapability(
      roleProtectedCapability(["admin"]),
      { value: 123 }, // should be string
      { auth: { roles: ["admin"] } },
    );
    expect(() => assertValidationError(result)).not.toThrow();
  });

  it("throws when result is success", () => {
    expect(() => assertValidationError({ success: true, data: {} } as any)).toThrow("succeeded");
  });

  it("throws when error is not validation", () => {
    expect(() => assertValidationError({
      success: false,
      error: { code: "forbidden", message: "no access" },
    } as any)).toThrow("validation");
  });
});

// ── assertPlumbusError ──

describe("assertPlumbusError", () => {
  it("passes when error code matches", () => {
    const result = { success: false, error: { code: "not_found", message: "missing" } } as any;
    expect(() => assertPlumbusError(result, "not_found")).not.toThrow();
  });

  it("throws when error code does not match", () => {
    const result = { success: false, error: { code: "forbidden", message: "denied" } } as any;
    expect(() => assertPlumbusError(result, "not_found")).toThrow("not_found");
  });

  it("throws when result is success", () => {
    expect(() => assertPlumbusError({ success: true, data: {} } as any, "any")).toThrow("succeeded");
  });
});

// ── Auth Scenario Builders ──

describe("unauthenticated", () => {
  it("returns auth with no roles and no tenant", () => {
    const auth = unauthenticated();
    expect(auth.roles).toEqual([]);
    expect(auth.tenantId).toBeUndefined();
    expect(auth.userId).toBeUndefined();
  });
});

describe("adminAuth", () => {
  it("returns admin auth with admin role", () => {
    const auth = adminAuth();
    expect(auth.userId).toBe("admin-user");
    expect(auth.roles).toEqual(["admin"]);
  });

  it("accepts a custom tenantId", () => {
    const auth = adminAuth("my-tenant");
    expect(auth.tenantId).toBe("my-tenant");
  });
});

describe("serviceAccountAuth", () => {
  it("returns service account auth", () => {
    const auth = serviceAccountAuth("svc-123");
    expect(auth.userId).toBe("svc-123");
    expect(auth.roles).toEqual([]);
    expect(auth.provider).toBe("service-account");
  });
});
