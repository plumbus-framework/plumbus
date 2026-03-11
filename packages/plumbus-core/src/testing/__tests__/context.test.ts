import { describe, expect, it } from "vitest";
import {
    createInMemoryRepository,
    createTestAuth,
    createTestContext,
    createTestData,
    fixedTime,
    mockAI,
    mockAudit,
    mockEvents,
    mockFlows,
    mockLogger,
} from "../context.js";

// ── createTestAuth ──

describe("createTestAuth", () => {
  it("returns default auth values when called without options", () => {
    const auth = createTestAuth();
    expect(auth.userId).toBe("test-user");
    expect(auth.roles).toEqual(["user"]);
    expect(auth.scopes).toEqual([]);
    expect(auth.tenantId).toBe("test-tenant");
    expect(auth.provider).toBe("test");
    expect(auth.sessionId).toBeUndefined();
  });

  it("overrides individual fields", () => {
    const auth = createTestAuth({ userId: "custom-user", roles: ["admin"], tenantId: "t-1" });
    expect(auth.userId).toBe("custom-user");
    expect(auth.roles).toEqual(["admin"]);
    expect(auth.tenantId).toBe("t-1");
    expect(auth.provider).toBe("test"); // default preserved
  });

  it("supports empty roles for unauthenticated scenarios", () => {
    const auth = createTestAuth({ roles: [] });
    expect(auth.roles).toEqual([]);
  });

  it("supports undefined userId for anonymous access", () => {
    const auth = createTestAuth({ userId: undefined });
    expect(auth.userId).toBeUndefined();
  });

  it("allows sessionId override", () => {
    const auth = createTestAuth({ sessionId: "sess-123" });
    expect(auth.sessionId).toBe("sess-123");
  });
});

// ── mockAudit ──

describe("mockAudit", () => {
  it("records audit events", async () => {
    const audit = mockAudit();
    await audit.record("user.login", { ip: "1.2.3.4" });
    await audit.record("user.logout");
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toEqual({ eventType: "user.login", metadata: { ip: "1.2.3.4" } });
    expect(audit.records[1]).toEqual({ eventType: "user.logout", metadata: undefined });
  });

  it("clears recorded events", async () => {
    const audit = mockAudit();
    await audit.record("a");
    await audit.record("b");
    audit.clear();
    expect(audit.records).toHaveLength(0);
  });

  it("starts with empty records", () => {
    const audit = mockAudit();
    expect(audit.records).toEqual([]);
  });
});

// ── mockEvents ──

describe("mockEvents", () => {
  it("captures emitted events", async () => {
    const events = mockEvents();
    await events.emit("order.created", { orderId: "123" });
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0]).toEqual({ eventName: "order.created", payload: { orderId: "123" } });
  });

  it("clears emitted events", async () => {
    const events = mockEvents();
    await events.emit("a", {});
    events.clear();
    expect(events.emitted).toHaveLength(0);
  });

  it("captures multiple events in order", async () => {
    const events = mockEvents();
    await events.emit("first", 1);
    await events.emit("second", 2);
    await events.emit("third", 3);
    expect(events.emitted.map((e) => e.eventName)).toEqual(["first", "second", "third"]);
  });
});

// ── mockFlows ──

describe("mockFlows", () => {
  it("tracks started flows", async () => {
    const flows = mockFlows();
    const exec = await flows.start("order-flow", { orderId: "1" });
    expect(exec.id).toMatch(/^flow-exec-/);
    expect(exec.flowName).toBe("order-flow");
    expect(exec.status).toBe("running");
    expect(flows.started).toHaveLength(1);
    expect(flows.started[0]).toEqual({ flowName: "order-flow", input: { orderId: "1" } });
  });

  it("generates unique execution ids", async () => {
    const flows = mockFlows();
    const exec1 = await flows.start("a", {});
    const exec2 = await flows.start("b", {});
    expect(exec1.id).not.toBe(exec2.id);
  });

  it("provides noop resume and cancel", async () => {
    const flows = mockFlows();
    await expect(flows.resume("x")).resolves.toBeUndefined();
    await expect(flows.cancel("x")).resolves.toBeUndefined();
  });

  it("returns status for any execution id", async () => {
    const flows = mockFlows();
    const status = await flows.status("arbitrary-id");
    expect(status.id).toBe("arbitrary-id");
  });

  it("clears started flows", async () => {
    const flows = mockFlows();
    await flows.start("a", {});
    flows.clear();
    expect(flows.started).toHaveLength(0);
  });
});

// ── mockAI ──

describe("mockAI", () => {
  it("returns default responses when no config given", async () => {
    const ai = mockAI();
    const gen = await ai.generate({ prompt: "test", input: {} });
    expect(gen).toEqual({ text: "mock-ai-response" });
    const ext = await ai.extract({ schema: {} as any, text: "data" });
    expect(ext).toEqual({});
    const cls = await ai.classify({ labels: ["a"], text: "item" });
    expect(cls).toEqual(["default"]);
    const ret = await ai.retrieve({ query: "query" });
    expect(ret).toEqual([]);
  });

  it("returns configured responses", async () => {
    const ai = mockAI({
      generate: { text: "custom" },
      extract: { name: "test" },
      classify: ["A", "B"],
      retrieve: [{ content: "doc", source: "test", score: 1.0, metadata: {} }],
    });
    expect(await ai.generate({ prompt: "p", input: {} })).toEqual({ text: "custom" });
    expect(await ai.extract({ schema: {} as any, text: "d" })).toEqual({ name: "test" });
    expect(await ai.classify({ labels: [], text: "i" })).toEqual(["A", "B"]);
    expect(await ai.retrieve({ query: "q" })).toEqual([{ content: "doc", source: "test", score: 1.0, metadata: {} }]);
  });

  it("allows partial configuration", async () => {
    const ai = mockAI({ generate: "hello" });
    expect(await ai.generate({ prompt: "p", input: {} })).toBe("hello");
    // Other methods still return defaults
    expect(await ai.extract({ schema: {} as any, text: "d" })).toEqual({});
  });
});

// ── mockLogger ──

describe("mockLogger", () => {
  it("captures log entries by level", () => {
    const logger = mockLogger();
    logger.info("info message", { key: "val" });
    logger.warn("warn message");
    logger.error("error message", { err: true });
    expect(logger.logs).toHaveLength(3);
    expect(logger.logs[0]).toEqual({ level: "info", message: "info message", metadata: { key: "val" } });
    expect(logger.logs[1]).toEqual({ level: "warn", message: "warn message", metadata: undefined });
    expect(logger.logs[2]).toEqual({ level: "error", message: "error message", metadata: { err: true } });
  });

  it("clears logs", () => {
    const logger = mockLogger();
    logger.info("a");
    logger.clear();
    expect(logger.logs).toHaveLength(0);
  });
});

// ── createInMemoryRepository ──

describe("createInMemoryRepository", () => {
  it("creates from initial data", async () => {
    const repo = createInMemoryRepository([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]);
    const alice = await repo.findById("1");
    expect(alice).toEqual({ id: "1", name: "Alice" });
  });

  it("generates ids for records without id", async () => {
    const repo = createInMemoryRepository([{ name: "noId" }]);
    const all = await repo.findMany();
    expect(all).toHaveLength(1);
    expect((all[0] as any).id).toBeDefined();
    expect((all[0] as any).name).toBe("noId");
  });

  it("CRUD operations work correctly", async () => {
    const repo = createInMemoryRepository<{ id: string; name: string }>();

    // Create
    const created = await repo.create({ id: "1", name: "Test" });
    expect(created).toEqual({ id: "1", name: "Test" });

    // Read
    const found = await repo.findById("1");
    expect(found).toEqual({ id: "1", name: "Test" });

    // Update
    const updated = await repo.update("1", { name: "Updated" });
    expect(updated).toEqual({ id: "1", name: "Updated" });

    // Delete
    await repo.delete("1");
    const deleted = await repo.findById("1");
    expect(deleted).toBeNull();
  });

  it("returns null for non-existent ID", async () => {
    const repo = createInMemoryRepository();
    expect(await repo.findById("missing")).toBeNull();
  });

  it("throws on update of non-existent record", async () => {
    const repo = createInMemoryRepository();
    await expect(repo.update("missing", { name: "x" })).rejects.toThrow("Record not found");
  });

  it("findMany filters by query fields", async () => {
    const repo = createInMemoryRepository([
      { id: "1", status: "active", team: "A" },
      { id: "2", status: "active", team: "B" },
      { id: "3", status: "inactive", team: "A" },
    ]);
    const activeTeamA = await repo.findMany({ status: "active", team: "A" });
    expect(activeTeamA).toHaveLength(1);
    expect((activeTeamA[0] as any).id).toBe("1");
  });

  it("findMany returns all records without query", async () => {
    const repo = createInMemoryRepository([{ id: "1" }, { id: "2" }]);
    const all = await repo.findMany();
    expect(all).toHaveLength(2);
  });
});

// ── createTestData ──

describe("createTestData", () => {
  it("creates repositories from entity map", async () => {
    const data = createTestData({
      users: [{ id: "1", name: "Alice" }],
      orders: [{ id: "o1", total: 100 }],
    });
    const user = await data.users!.findById("1");
    expect((user as any).name).toBe("Alice");
    const order = await data.orders!.findById("o1");
    expect((order as any).total).toBe(100);
  });

  it("auto-creates repositories on access via proxy", async () => {
    const data = createTestData();
    // Access a non-existent entity — should auto-create
    const newRepo = data.widgets;
    expect(newRepo).toBeDefined();
    const all = await newRepo!.findMany();
    expect(all).toEqual([]);
  });

  it("returns same repository on repeated access", () => {
    const data = createTestData();
    const repo1 = data.things;
    const repo2 = data.things;
    expect(repo1).toBe(repo2);
  });
});

// ── fixedTime ──

describe("fixedTime", () => {
  it("returns default date (2025-01-01)", () => {
    const time = fixedTime();
    expect(time.now()).toEqual(new Date("2025-01-01T00:00:00Z"));
  });

  it("returns a custom fixed date", () => {
    const custom = new Date("2024-06-15T12:00:00Z");
    const time = fixedTime(custom);
    expect(time.now()).toEqual(custom);
  });

  it("always returns the same date", () => {
    const time = fixedTime();
    const t1 = time.now();
    const t2 = time.now();
    expect(t1).toBe(t2); // same object reference
  });
});

// ── createTestContext ──

describe("createTestContext", () => {
  it("creates a valid execution context with defaults", () => {
    const ctx = createTestContext();
    expect(ctx.auth).toBeDefined();
    expect(ctx.auth.userId).toBe("test-user");
    expect(ctx.data).toBeDefined();
    expect(ctx.events).toBeDefined();
    expect(ctx.flows).toBeDefined();
    expect(ctx.ai).toBeDefined();
    expect(ctx.audit).toBeDefined();
    expect(ctx.logger).toBeDefined();
    expect(ctx.time).toBeDefined();
  });

  it("overrides auth via options", () => {
    const ctx = createTestContext({ auth: { userId: "custom", roles: ["admin"] } });
    expect(ctx.auth.userId).toBe("custom");
    expect(ctx.auth.roles).toEqual(["admin"]);
  });

  it("uses custom data", async () => {
    const ctx = createTestContext({
      data: { users: [{ id: "1", name: "Alice" }] },
    });
    const user = await ctx.data.users!.findById("1");
    expect((user as any).name).toBe("Alice");
  });

  it("accepts AIResponse shorthand", async () => {
    const ctx = createTestContext({
      ai: { generate: { text: "custom-ai" } },
    });
    const result = await ctx.ai.generate({ prompt: "p", input: {} });
    expect(result).toEqual({ text: "custom-ai" });
  });

  it("accepts a full AIService", async () => {
    const ai = mockAI({ generate: "full-service" });
    const ctx = createTestContext({ ai });
    const result = await ctx.ai.generate({ prompt: "p", input: {} });
    expect(result).toBe("full-service");
  });

  it("accepts a Date for time", () => {
    const date = new Date("2030-01-01T00:00:00Z");
    const ctx = createTestContext({ time: date });
    expect(ctx.time.now()).toEqual(date);
  });

  it("accepts a TimeService for time", () => {
    const time = fixedTime(new Date("2020-01-01T00:00:00Z"));
    const ctx = createTestContext({ time });
    expect(ctx.time.now()).toEqual(new Date("2020-01-01T00:00:00Z"));
  });

  it("accepts config overrides", () => {
    const ctx = createTestContext({ config: { featureFlag: true } });
    expect(ctx.config).toEqual({ featureFlag: true });
  });

  it("provides custom event service", async () => {
    const events = mockEvents();
    const ctx = createTestContext({ events });
    await ctx.events.emit("test", {});
    expect(events.emitted).toHaveLength(1);
  });

  it("provides custom audit service", async () => {
    const audit = mockAudit();
    const ctx = createTestContext({ audit });
    await ctx.audit.record("test");
    expect(audit.records).toHaveLength(1);
  });
});
