import { describe, expect, it } from "vitest";
import type { EntityDefinition } from "../../types/entity.js";
import type { FieldDescriptor } from "../../types/fields.js";
import { checkPromptSecurity, type AISecurityConfig } from "../security.js";

function makeEntity(
  name: string,
  fields: Record<string, FieldDescriptor>,
): EntityDefinition {
  return { name, fields };
}

describe("AI Security Boundaries", () => {
  const entities: EntityDefinition[] = [
    makeEntity("User", {
      name: { type: "string", options: { classification: "public" } },
      email: { type: "string", options: { classification: "personal" } },
      ssn: { type: "string", options: { classification: "highly_sensitive" } },
      salary: { type: "number", options: { classification: "sensitive" } },
    }),
    makeEntity("Order", {
      orderId: { type: "id", options: { classification: "internal" } },
      total: { type: "number", options: { classification: "internal" } },
    }),
  ];

  it("returns safe when no classified fields match", () => {
    const result = checkPromptSecurity(
      { query: "hello", context: "world" },
      { entities },
    );
    expect(result.safe).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.redactedInput).toBeUndefined();
  });

  it("warns on sensitive fields", () => {
    const result = checkPromptSecurity(
      { salary: 50000, name: "Alice" },
      { entities, warnThreshold: "sensitive" },
    );
    expect(result.safe).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("salary");
    expect(result.warnings[0]!.classification).toBe("sensitive");
  });

  it("redacts highly_sensitive fields", () => {
    const result = checkPromptSecurity(
      { ssn: "123-45-6789", name: "Alice" },
      { entities, redactThreshold: "highly_sensitive" },
    );
    expect(result.safe).toBe(false);
    expect(result.redactedInput).toBeDefined();
    expect(result.redactedInput!.ssn).toBe("[REDACTED]");
    expect(result.redactedInput!.name).toBe("Alice");
  });

  it("handles custom warn and redact thresholds", () => {
    const config: AISecurityConfig = {
      entities,
      warnThreshold: "personal",
      redactThreshold: "sensitive",
    };
    const result = checkPromptSecurity(
      { email: "a@b.com", salary: 50000 },
      config,
    );
    expect(result.warnings).toHaveLength(2); // email (personal) + salary (sensitive)
    expect(result.redactedInput).toBeDefined();
    expect(result.redactedInput!.salary).toBe("[REDACTED]");
    expect(result.redactedInput!.email).toBe("a@b.com"); // personal < sensitive redact threshold
  });

  it("returns safe with no entities configured", () => {
    const result = checkPromptSecurity({ ssn: "123", salary: 50000 });
    expect(result.safe).toBe(true);
  });

  it("picks highest classification when field name appears in multiple entities", () => {
    const entities2: EntityDefinition[] = [
      makeEntity("A", {
        field1: { type: "string", options: { classification: "internal" } },
      }),
      makeEntity("B", {
        field1: { type: "string", options: { classification: "sensitive" } },
      }),
    ];
    const result = checkPromptSecurity(
      { field1: "value" },
      { entities: entities2, warnThreshold: "sensitive" },
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.classification).toBe("sensitive");
  });

  it("detects sensitive fields in nested objects", () => {
    const result = checkPromptSecurity(
      { user: { ssn: "123-45-6789", name: "Alice" } },
      { entities },
    );
    expect(result.safe).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.field).toBe("user.ssn");
    expect(result.warnings[0]!.classification).toBe("highly_sensitive");
  });

  it("redacts sensitive fields in nested objects", () => {
    const result = checkPromptSecurity(
      { user: { ssn: "123-45-6789", name: "Alice" } },
      { entities, redactThreshold: "highly_sensitive" },
    );
    expect(result.redactedInput).toBeDefined();
    expect((result.redactedInput!.user as Record<string, unknown>).ssn).toBe("[REDACTED]");
    expect((result.redactedInput!.user as Record<string, unknown>).name).toBe("Alice");
  });

  it("detects sensitive fields at multiple nesting levels", () => {
    const result = checkPromptSecurity(
      { salary: 50000, details: { user: { ssn: "123-45-6789" } } },
      { entities, warnThreshold: "sensitive" },
    );
    expect(result.warnings).toHaveLength(2);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toContain("salary");
    expect(fields).toContain("details.user.ssn");
  });
});
