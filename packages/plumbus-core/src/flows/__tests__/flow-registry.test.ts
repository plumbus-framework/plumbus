import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow } from "../../define/defineFlow.js";
import { FlowStepType } from "../../types/enums.js";
import { FlowRegistry } from "../registry.js";

function makeFlow(name: string, domain = "orders", opts?: { trigger?: string; schedule?: string }) {
  return defineFlow({
    name,
    domain,
    input: z.object({ id: z.string() }),
    steps: [
      { name: "step1", type: FlowStepType.Capability },
    ],
    trigger: opts?.trigger ? { event: opts.trigger } : undefined,
    schedule: opts?.schedule ? { cron: opts.schedule } : undefined,
  });
}

describe("FlowRegistry", () => {
  it("registers and retrieves a flow by name", () => {
    const reg = new FlowRegistry();
    const flow = makeFlow("order-processing");
    reg.register(flow);
    expect(reg.get("order-processing")).toBe(flow);
  });

  it("throws on duplicate registration", () => {
    const reg = new FlowRegistry();
    reg.register(makeFlow("order-processing"));
    expect(() => reg.register(makeFlow("order-processing"))).toThrow("already registered");
  });

  it("has() returns correct boolean", () => {
    const reg = new FlowRegistry();
    expect(reg.has("nope")).toBe(false);
    reg.register(makeFlow("order-processing"));
    expect(reg.has("order-processing")).toBe(true);
  });

  it("getAll() lists all flows", () => {
    const reg = new FlowRegistry();
    reg.registerAll([makeFlow("a"), makeFlow("b")]);
    expect(reg.getAll()).toHaveLength(2);
  });

  it("getByDomain() filters correctly", () => {
    const reg = new FlowRegistry();
    reg.register(makeFlow("a", "billing"));
    reg.register(makeFlow("b", "orders"));
    reg.register(makeFlow("c", "billing"));
    expect(reg.getByDomain("billing")).toHaveLength(2);
    expect(reg.getByDomain("orders")).toHaveLength(1);
  });

  it("getByTriggerEvent() finds flows with matching event trigger", () => {
    const reg = new FlowRegistry();
    reg.register(makeFlow("a", "orders", { trigger: "order.created" }));
    reg.register(makeFlow("b", "orders", { trigger: "order.updated" }));
    reg.register(makeFlow("c", "orders"));
    expect(reg.getByTriggerEvent("order.created")).toHaveLength(1);
    expect(reg.getByTriggerEvent("order.created")[0]!.name).toBe("a");
    expect(reg.getByTriggerEvent("nothing")).toHaveLength(0);
  });

  it("getScheduled() returns flows with a schedule", () => {
    const reg = new FlowRegistry();
    reg.register(makeFlow("a", "orders", { schedule: "every:60m" }));
    reg.register(makeFlow("b", "orders"));
    expect(reg.getScheduled()).toHaveLength(1);
    expect(reg.getScheduled()[0]!.name).toBe("a");
  });

  it("discoverFlows() returns empty array for non-existent directory", async () => {
    const reg = new FlowRegistry();
    const result = await reg.discoverFlows("/tmp/non-existent-dir-plumbus");
    expect(result).toEqual([]);
  });
});
