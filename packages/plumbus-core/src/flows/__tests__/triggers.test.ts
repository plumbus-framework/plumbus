import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineFlow } from "../../define/defineFlow.js";
import { FlowStepType } from "../../types/enums.js";
import type { EventEnvelope } from "../../types/event.js";
import { FlowRegistry } from "../registry.js";
import { createFlowTriggerHandler } from "../triggers.js";

describe("FlowTriggerHandler", () => {
  it("starts flows matching the event trigger", async () => {
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: "on-order-created",
        domain: "orders",
        input: z.object({}),
        steps: [{ name: "s1", type: FlowStepType.Capability }],
        trigger: { event: "order.created" },
      }),
    );

    const started: any[] = [];
    const engine = {
      start: vi.fn().mockImplementation(async (name: string, input: any, auth: any, opts: any) => {
        started.push({ name, input, auth, opts });
        return { id: "exec-1", flowName: name, status: "created" };
      }),
    } as any;

    const handler = createFlowTriggerHandler({ registry, engine });

    const envelope: EventEnvelope = {
      id: "evt-1",
      eventType: "order.created",
      version: "1",
      occurredAt: new Date(),
      actor: "user-1",
      tenantId: "tenant-1",
      correlationId: "corr-1",
      payload: { orderId: "abc" },
    };

    const count = await handler.handleEvent(envelope);
    expect(count).toBe(1);
    expect(started).toHaveLength(1);
    expect(started[0].name).toBe("on-order-created");
    expect(started[0].auth.userId).toBe("user-1");
    expect(started[0].opts.triggerEventId).toBe("evt-1");
    expect(started[0].opts.correlationId).toBe("corr-1");
  });

  it("returns 0 when no flows match", async () => {
    const registry = new FlowRegistry();
    const engine = { start: vi.fn() } as any;
    const handler = createFlowTriggerHandler({ registry, engine });

    const envelope: EventEnvelope = {
      id: "evt-2",
      eventType: "no.match",
      version: "1",
      occurredAt: new Date(),
      actor: "user-1",
      correlationId: "corr-2",
      payload: {},
    };

    const count = await handler.handleEvent(envelope);
    expect(count).toBe(0);
    expect(engine.start).not.toHaveBeenCalled();
  });

  it("starts multiple flows when multiple match", async () => {
    const registry = new FlowRegistry();
    registry.register(
      defineFlow({
        name: "flow-a",
        domain: "orders",
        input: z.object({}),
        steps: [{ name: "s1", type: FlowStepType.Capability }],
        trigger: { event: "order.created" },
      }),
    );
    registry.register(
      defineFlow({
        name: "flow-b",
        domain: "notifications",
        input: z.object({}),
        steps: [{ name: "s1", type: FlowStepType.Capability }],
        trigger: { event: "order.created" },
      }),
    );

    const engine = {
      start: vi.fn().mockResolvedValue({ id: "x", flowName: "x", status: "created" }),
    } as any;

    const handler = createFlowTriggerHandler({ registry, engine });
    const count = await handler.handleEvent({
      id: "evt-3",
      eventType: "order.created",
      version: "1",
      occurredAt: new Date(),
      actor: "user-1",
      correlationId: "corr-3",
      payload: {},
    });

    expect(count).toBe(2);
    expect(engine.start).toHaveBeenCalledTimes(2);
  });
});
