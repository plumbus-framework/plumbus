import { describe, expect, it } from "vitest";
import { field } from "../../fields/index.js";
import type { EntityDefinition } from "../../types/entity.js";
import { EntityRegistry } from "../registry.js";

function makeEntity(name: string, overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    name,
    fields: {
      id: field.id(),
      title: field.string({ required: true }),
    },
    ...overrides,
  };
}

describe("EntityRegistry", () => {
  it("registers and retrieves an entity", () => {
    const registry = new EntityRegistry();
    const entity = makeEntity("Task");
    registry.register(entity);

    expect(registry.getEntity("Task")).toBe(entity);
    expect(registry.getTable("Task")).toBeDefined();
  });

  it("throws on duplicate registration", () => {
    const registry = new EntityRegistry();
    registry.register(makeEntity("Task"));

    expect(() => registry.register(makeEntity("Task"))).toThrow(
      'Entity "Task" is already registered',
    );
  });

  it("returns undefined for unknown entity", () => {
    const registry = new EntityRegistry();
    expect(registry.getEntity("Missing")).toBeUndefined();
    expect(registry.getTable("Missing")).toBeUndefined();
  });

  it("registers multiple entities at once", () => {
    const registry = new EntityRegistry();
    registry.registerAll([makeEntity("A"), makeEntity("B"), makeEntity("C")]);
    expect(registry.getAllEntities()).toHaveLength(3);
  });

  it("getAllTables returns record keyed by entity name", () => {
    const registry = new EntityRegistry();
    registry.registerAll([makeEntity("Foo"), makeEntity("Bar")]);
    const tables = registry.getAllTables();
    expect(Object.keys(tables)).toEqual(["Foo", "Bar"]);
  });

  it("createDataService returns repos for all entities", () => {
    const registry = new EntityRegistry();
    registry.registerAll([
      makeEntity("Order"),
      makeEntity("Item"),
    ]);

    // Use a mock db — the DataService creation just wires up repos
    const mockDb = {} as any;
    const auth = { userId: "u1", roles: ["admin"], scopes: [], provider: "test" };

    const dataService = registry.createDataService({ db: mockDb, auth });
    expect(Object.keys(dataService)).toEqual(["Order", "Item"]);
    expect(dataService["Order"]).toBeDefined();
    expect(dataService["Item"]).toBeDefined();
  });
});
