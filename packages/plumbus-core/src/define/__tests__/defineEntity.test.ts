import { describe, expect, it } from "vitest";
import { field } from "../../fields/index.js";
import { defineEntity } from "../defineEntity.js";

describe("defineEntity", () => {
  const validConfig = () => ({
    name: "User",
    fields: {
      id: field.id(),
      email: field.string({ required: true, unique: true, classification: "personal" as const }),
      name: field.string({ required: true }),
      active: field.boolean({ default: true }),
    },
  });

  it("creates a valid entity definition", () => {
    const entity = defineEntity(validConfig());
    expect(entity.name).toBe("User");
    expect(Object.keys(entity.fields)).toEqual(["id", "email", "name", "active"]);
  });

  it("freezes the returned definition", () => {
    const entity = defineEntity(validConfig());
    expect(Object.isFrozen(entity)).toBe(true);
  });

  it("accepts optional fields", () => {
    const entity = defineEntity({
      ...validConfig(),
      description: "Application user",
      domain: "identity",
      tags: ["core"],
      owner: "team-auth",
      indexes: [["email"], ["name", "active"]],
      retention: { duration: "365d" },
      tenantScoped: true,
    });
    expect(entity.indexes).toEqual([["email"], ["name", "active"]]);
    expect(entity.tenantScoped).toBe(true);
  });

  it("throws if name is missing", () => {
    expect(() => defineEntity({ ...validConfig(), name: "" })).toThrow(
      "name is required",
    );
  });

  it("throws if fields is empty", () => {
    expect(() => defineEntity({ ...validConfig(), fields: {} })).toThrow(
      "at least one field is required",
    );
  });

  it("throws if index references unknown field", () => {
    expect(() =>
      defineEntity({
        ...validConfig(),
        indexes: [["nonexistent"]],
      }),
    ).toThrow('index references unknown field "nonexistent"');
  });
});
