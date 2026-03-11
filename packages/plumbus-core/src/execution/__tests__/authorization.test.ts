import { describe, expect, it } from "vitest";
import type { AccessPolicy, AuthContext } from "../../types/security.js";
import { evaluateAccess } from "../authorization.js";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "user-1",
    roles: ["editor"],
    scopes: ["read", "write"],
    provider: "test",
    tenantId: "tenant-1",
    ...overrides,
  };
}

describe("evaluateAccess", () => {
  it("denies when no policy is provided", () => {
    const result = evaluateAccess(undefined, makeAuth());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No access policy");
  });

  it("allows public capabilities without authentication", () => {
    const policy: AccessPolicy = { public: true };
    const result = evaluateAccess(policy, makeAuth({ userId: undefined }));
    expect(result.allowed).toBe(true);
  });

  it("denies unauthenticated non-public access", () => {
    const policy: AccessPolicy = { roles: ["admin"] };
    const result = evaluateAccess(policy, makeAuth({ userId: undefined }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Authentication required");
  });

  it("allows when caller has a required role", () => {
    const policy: AccessPolicy = { roles: ["editor", "admin"] };
    const result = evaluateAccess(policy, makeAuth({ roles: ["editor"] }));
    expect(result.allowed).toBe(true);
  });

  it("denies when caller lacks required roles", () => {
    const policy: AccessPolicy = { roles: ["admin"] };
    const result = evaluateAccess(policy, makeAuth({ roles: ["viewer"] }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Required roles");
  });

  it("allows when caller has all required scopes", () => {
    const policy: AccessPolicy = { scopes: ["read", "write"] };
    const result = evaluateAccess(
      policy,
      makeAuth({ scopes: ["read", "write", "delete"] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("denies when caller is missing a required scope", () => {
    const policy: AccessPolicy = { scopes: ["read", "admin"] };
    const result = evaluateAccess(
      policy,
      makeAuth({ scopes: ["read"] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Missing scopes: admin");
  });

  it("denies tenant-scoped access without tenantId", () => {
    const policy: AccessPolicy = { tenantScoped: true };
    const result = evaluateAccess(
      policy,
      makeAuth({ tenantId: undefined }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Tenant context required");
  });

  it("allows tenant-scoped access with tenantId", () => {
    const policy: AccessPolicy = { tenantScoped: true };
    const result = evaluateAccess(
      policy,
      makeAuth({ tenantId: "t-1" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("allows recognized service accounts", () => {
    const policy: AccessPolicy = {
      serviceAccounts: ["svc-worker"],
      roles: ["admin"],
    };
    const result = evaluateAccess(
      policy,
      makeAuth({ userId: "svc-worker", roles: [] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("falls through to role check for non-service accounts", () => {
    const policy: AccessPolicy = {
      serviceAccounts: ["svc-worker"],
      roles: ["admin"],
    };
    const result = evaluateAccess(
      policy,
      makeAuth({ userId: "regular-user", roles: ["viewer"] }),
    );
    expect(result.allowed).toBe(false);
  });

  it("allows when both roles and scopes match", () => {
    const policy: AccessPolicy = {
      roles: ["editor"],
      scopes: ["write"],
    };
    const result = evaluateAccess(
      policy,
      makeAuth({ roles: ["editor"], scopes: ["read", "write"] }),
    );
    expect(result.allowed).toBe(true);
  });
});
