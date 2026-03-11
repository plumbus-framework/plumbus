import { describe, expect, it } from "vitest";
import { createJwtAdapter } from "../adapter.js";

// Helper: create a fake JWT (header.payload.signature) with base64url-encoded payload
function fakeJwt(
  payload: Record<string, unknown>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = "fake-signature";
  return `${header}.${body}.${sig}`;
}

describe("createJwtAdapter", () => {
  const adapter = createJwtAdapter({ secret: "test-secret" });

  it("returns null for missing authorization header", async () => {
    const result = await adapter.authenticate(undefined);
    expect(result).toBeNull();
  });

  it("returns null for non-Bearer token", async () => {
    const result = await adapter.authenticate("Basic abc123");
    expect(result).toBeNull();
  });

  it("returns null for malformed JWT", async () => {
    const result = await adapter.authenticate("Bearer not.a.valid.jwt");
    expect(result).toBeNull();
  });

  it("extracts AuthContext from valid JWT claims", async () => {
    const token = fakeJwt({
      sub: "user-42",
      roles: ["admin", "editor"],
      scope: "read write",
      tenant_id: "t-1",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user-42");
    expect(result!.roles).toEqual(["admin", "editor"]);
    expect(result!.scopes).toEqual(["read", "write"]);
    expect(result!.tenantId).toBe("t-1");
    expect(result!.provider).toBe("jwt");
  });

  it("handles space-separated scopes", async () => {
    const token = fakeJwt({
      sub: "u1",
      scope: "read write delete",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result!.scopes).toEqual(["read", "write", "delete"]);
  });

  it("handles comma-separated roles", async () => {
    const token = fakeJwt({
      sub: "u1",
      roles: "admin,editor",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result!.roles).toEqual(["admin", "editor"]);
  });

  it("returns null for expired tokens", async () => {
    const token = fakeJwt({
      sub: "u1",
      exp: Math.floor(Date.now() / 1000) - 60, // expired 1 min ago
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it("validates issuer when configured", async () => {
    const strictAdapter = createJwtAdapter({
      secret: "s",
      issuer: "my-app",
    });
    const token = fakeJwt({
      sub: "u1",
      iss: "wrong-issuer",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await strictAdapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it("allows matching issuer", async () => {
    const strictAdapter = createJwtAdapter({
      secret: "s",
      issuer: "my-app",
    });
    const token = fakeJwt({
      sub: "u1",
      iss: "my-app",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await strictAdapter.authenticate(`Bearer ${token}`);
    expect(result).not.toBeNull();
  });

  it("validates audience when configured", async () => {
    const audAdapter = createJwtAdapter({
      secret: "s",
      audience: "api",
    });
    const token = fakeJwt({
      sub: "u1",
      aud: "other-service",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await audAdapter.authenticate(`Bearer ${token}`);
    expect(result).toBeNull();
  });

  it("supports custom claim mapping", async () => {
    const customAdapter = createJwtAdapter({
      secret: "s",
      claimMapping: {
        userId: "user_id",
        roles: "permissions",
        scopes: "grants",
        tenantId: "org_id",
      },
    });
    const token = fakeJwt({
      user_id: "custom-user",
      permissions: ["superadmin"],
      grants: "all",
      org_id: "org-99",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await customAdapter.authenticate(`Bearer ${token}`);
    expect(result!.userId).toBe("custom-user");
    expect(result!.roles).toEqual(["superadmin"]);
    expect(result!.tenantId).toBe("org-99");
  });

  it("sets authenticatedAt from iat claim", async () => {
    const iat = Math.floor(Date.now() / 1000) - 300;
    const token = fakeJwt({
      sub: "u1",
      iat,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await adapter.authenticate(`Bearer ${token}`);
    expect(result!.authenticatedAt).toEqual(new Date(iat * 1000));
  });
});
