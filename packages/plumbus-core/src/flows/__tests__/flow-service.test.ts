import { describe, expect, it, vi } from "vitest";
import { createFlowService } from "../flow-service.js";

describe("FlowService", () => {
  function mockEngine() {
    return {
      start: vi.fn().mockResolvedValue({ id: "exec-1", flowName: "test-flow", status: "created" }),
      resume: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({ id: "exec-1", flowName: "test-flow", status: "running" }),
      runNext: vi.fn(),
    };
  }

  const auth = {
    userId: "user-1",
    tenantId: "tenant-1",
    roles: ["admin"],
    scopes: [],
    provider: "test",
  };

  it("start() delegates to engine with bound auth", async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    const result = await svc.start("test-flow", { data: 1 });
    expect(result.id).toBe("exec-1");
    expect(engine.start).toHaveBeenCalledWith("test-flow", { data: 1 }, auth);
  });

  it("resume() delegates to engine", async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    await svc.resume("exec-1", { signal: "approved" });
    expect(engine.resume).toHaveBeenCalledWith("exec-1", { signal: "approved" });
  });

  it("cancel() delegates to engine", async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    await svc.cancel("exec-1");
    expect(engine.cancel).toHaveBeenCalledWith("exec-1");
  });

  it("status() delegates to engine", async () => {
    const engine = mockEngine();
    const svc = createFlowService(engine as any, auth);

    const st = await svc.status("exec-1");
    expect(st.status).toBe("running");
    expect(engine.status).toHaveBeenCalledWith("exec-1");
  });
});
