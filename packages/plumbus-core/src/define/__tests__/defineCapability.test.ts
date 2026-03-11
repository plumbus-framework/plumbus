import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../defineCapability.js";

describe("defineCapability", () => {
  const validConfig = () => ({
    name: "getUser",
    kind: "query" as const,
    domain: "users",
    input: z.object({ userId: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
    effects: { data: ["User"], events: [], external: [], ai: false },
    handler: async (_ctx: any, input: z.infer<z.ZodObject<{ userId: z.ZodString }>>) => ({
      id: input.userId,
      name: "Test User",
    }),
  });

  it("creates a valid capability contract", () => {
    const cap = defineCapability(validConfig());
    expect(cap.name).toBe("getUser");
    expect(cap.kind).toBe("query");
    expect(cap.domain).toBe("users");
    expect(cap.effects.ai).toBe(false);
    expect(typeof cap.handler).toBe("function");
  });

  it("freezes the returned contract", () => {
    const cap = defineCapability(validConfig());
    expect(Object.isFrozen(cap)).toBe(true);
  });

  it("accepts optional fields", () => {
    const cap = defineCapability({
      ...validConfig(),
      description: "Fetches a user by ID",
      tags: ["user", "read"],
      version: "1.0.0",
      owner: "team-users",
      access: { roles: ["admin"], tenantScoped: true },
      audit: { event: "user.fetched", includeInput: ["userId"] },
      explanation: { enabled: true, summary: "Fetched user data" },
    });
    expect(cap.description).toBe("Fetches a user by ID");
    expect(cap.access?.roles).toEqual(["admin"]);
    expect(cap.audit?.event).toBe("user.fetched");
  });

  it("throws if name is missing", () => {
    expect(() =>
      defineCapability({ ...validConfig(), name: "" }),
    ).toThrow("name is required");
  });

  it("throws if kind is missing", () => {
    expect(() =>
      defineCapability({ ...validConfig(), kind: "" as any }),
    ).toThrow("kind is required");
  });

  it("throws if domain is missing", () => {
    expect(() =>
      defineCapability({ ...validConfig(), domain: "" }),
    ).toThrow("domain is required");
  });

  it("throws if input is not a Zod schema", () => {
    expect(() =>
      defineCapability({ ...validConfig(), input: {} as any }),
    ).toThrow("input must be a Zod schema");
  });

  it("throws if output is not a Zod schema", () => {
    expect(() =>
      defineCapability({ ...validConfig(), output: "string" as any }),
    ).toThrow("output must be a Zod schema");
  });

  it("throws if effects is missing", () => {
    expect(() =>
      defineCapability({ ...validConfig(), effects: undefined as any }),
    ).toThrow("effects declaration is required");
  });

  it("throws if handler is not a function", () => {
    expect(() =>
      defineCapability({ ...validConfig(), handler: "nope" as any }),
    ).toThrow("handler function is required");
  });
});
