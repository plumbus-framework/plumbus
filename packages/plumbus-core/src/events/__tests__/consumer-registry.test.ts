import { describe, expect, it } from "vitest";
import { ConsumerRegistry, type EventConsumer } from "../consumer-registry.js";

function makeConsumer(
  id: string,
  eventTypes: string[],
  versionConstraint?: string,
): EventConsumer {
  return {
    id,
    eventTypes,
    versionConstraint,
    handler: async () => {},
  };
}

describe("ConsumerRegistry", () => {
  it("registers and retrieves consumers by event type", () => {
    const reg = new ConsumerRegistry();
    const c = makeConsumer("c1", ["order.created"]);
    reg.register(c);
    expect(reg.getConsumers("order.created")).toEqual([c]);
  });

  it("returns empty array for unknown event type", () => {
    const reg = new ConsumerRegistry();
    expect(reg.getConsumers("nothing")).toEqual([]);
  });

  it("throws on duplicate consumer ID", () => {
    const reg = new ConsumerRegistry();
    reg.register(makeConsumer("c1", ["order.created"]));
    expect(() => reg.register(makeConsumer("c1", ["order.updated"]))).toThrow(
      'already registered',
    );
  });

  it("supports consumer subscribing to multiple event types", () => {
    const reg = new ConsumerRegistry();
    const c = makeConsumer("c1", ["order.created", "order.updated"]);
    reg.register(c);
    expect(reg.getConsumers("order.created")).toEqual([c]);
    expect(reg.getConsumers("order.updated")).toEqual([c]);
  });

  it("getById returns the consumer or undefined", () => {
    const reg = new ConsumerRegistry();
    const c = makeConsumer("c1", ["x"]);
    reg.register(c);
    expect(reg.getById("c1")).toBe(c);
    expect(reg.getById("c2")).toBeUndefined();
  });

  it("getAll returns all consumers", () => {
    const reg = new ConsumerRegistry();
    reg.registerAll([
      makeConsumer("a", ["x"]),
      makeConsumer("b", ["y"]),
    ]);
    expect(reg.getAll()).toHaveLength(2);
  });

  it("filters consumers by version constraint — exact", () => {
    const reg = new ConsumerRegistry();
    reg.register(makeConsumer("c1", ["evt"], "1"));
    reg.register(makeConsumer("c2", ["evt"], "2"));
    expect(reg.getConsumers("evt", "1").map((c) => c.id)).toEqual(["c1"]);
    expect(reg.getConsumers("evt", "2").map((c) => c.id)).toEqual(["c2"]);
  });

  it("filters consumers by version constraint — >=", () => {
    const reg = new ConsumerRegistry();
    reg.register(makeConsumer("old", ["evt"], "1"));
    reg.register(makeConsumer("new", ["evt"], ">=2"));
    expect(reg.getConsumers("evt", "3").map((c) => c.id)).toEqual(["new"]);
    expect(reg.getConsumers("evt", "1").map((c) => c.id)).toEqual(["old"]);
  });

  it("includes consumers without version constraint", () => {
    const reg = new ConsumerRegistry();
    reg.register(makeConsumer("any", ["evt"]));
    reg.register(makeConsumer("v1only", ["evt"], "1"));
    expect(reg.getConsumers("evt", "2").map((c) => c.id)).toEqual(["any"]);
    expect(reg.getConsumers("evt", "1").map((c) => c.id)).toEqual(["any", "v1only"]);
  });
});
