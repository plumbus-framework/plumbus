import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineEvent } from "../../define/defineEvent.js";
import { createEventEmitter, type EventEmitterConfig } from "../emitter.js";
import { EventRegistry } from "../registry.js";

/**
 * These tests mock the database insert and audit service
 * to verify emitter logic without a real PostgreSQL connection.
 */

function setup(opts?: { audit?: boolean; correlationId?: string; causationId?: string }) {
  const insertedRows: any[] = [];
  const auditRecords: any[] = [];

  // Minimal db mock that captures insert().values() calls
  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: any) => {
        insertedRows.push(row);
        return Promise.resolve();
      }),
    }),
  } as any;

  const registry = new EventRegistry();
  registry.register(
    defineEvent({
      name: "order.created",
      domain: "orders",
      version: "1",
      payload: z.object({ orderId: z.string() }),
    }),
  );

  const audit = opts?.audit
    ? { record: vi.fn().mockImplementation(async (action: string, meta: any) => { auditRecords.push({ action, ...meta }); }) }
    : undefined;

  const config: EventEmitterConfig = {
    db,
    auth: { userId: "user-1", tenantId: "tenant-1", roles: [], scopes: [], provider: "test" },
    registry,
    audit,
    correlationId: opts?.correlationId,
    causationId: opts?.causationId,
  };

  const emitter = createEventEmitter(config);
  return { emitter, insertedRows, auditRecords, db, audit };
}

describe("EventEmitter", () => {
  it("validates payload against registry schema", async () => {
    const { emitter } = setup();
    // Missing required field triggers Zod validation error
    await expect(emitter.emit("order.created", { wrong: "field" })).rejects.toThrow(
      "invalid payload",
    );
  });

  it("writes a valid event to the outbox", async () => {
    const { emitter, insertedRows } = setup();
    await emitter.emit("order.created", { orderId: "abc" });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      eventType: "order.created",
      version: "1",
      actor: "user-1",
      tenantId: "tenant-1",
      status: "pending",
    });
  });

  it("assigns UUID id and correlationId", async () => {
    const { emitter, insertedRows } = setup();
    await emitter.emit("order.created", { orderId: "abc" });
    expect(insertedRows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(insertedRows[0].correlationId).toBeTruthy();
  });

  it("uses provided correlationId and causationId", async () => {
    const { emitter, insertedRows } = setup({
      correlationId: "corr-x",
      causationId: "cause-y",
    });
    await emitter.emit("order.created", { orderId: "abc" });
    expect(insertedRows[0].correlationId).toBe("corr-x");
    expect(insertedRows[0].causationId).toBe("cause-y");
  });

  it("records audit when audit service is provided", async () => {
    const { emitter, auditRecords } = setup({ audit: true });
    await emitter.emit("order.created", { orderId: "abc" });
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].action).toBe("event.emitted.order.created");
    expect(auditRecords[0].outcome).toBe("success");
  });

  it("skips audit when no audit service provided", async () => {
    const { emitter, auditRecords } = setup({ audit: false });
    await emitter.emit("order.created", { orderId: "abc" });
    expect(auditRecords).toHaveLength(0);
  });

  it("allows unregistered event types (no schema validation)", async () => {
    const { emitter, insertedRows } = setup();
    await emitter.emit("custom.unregistered", { anything: true });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].eventType).toBe("custom.unregistered");
    expect(insertedRows[0].version).toBe("1"); // defaults to "1"
  });
});
