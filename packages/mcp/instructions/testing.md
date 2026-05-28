# Recipe: Testing MCP capabilities

`@plumbus/mcp/testing` exposes two helpers that wire a real `createMcpServer` to a real MCP `Client` over `InMemoryTransport`. Tests run the full pipeline (auth → access → handler → audit) without spinning up stdio or HTTP.

## `createTestMcpServer` — full integration

The 80% case. One call sets up registry, auth, deps, transport, and a pre-connected client.

```ts
import { createTestMcpServer } from "@plumbus/mcp/testing";
import { mcpTaskEntity } from "@plumbus/mcp";
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";
import { describe, expect, it } from "vitest";

const echo = defineCapability({
  name: "echo",
  kind: "query",
  domain: "test",
  description: "Echo back the message",
  input: z.object({ message: z.string() }),
  output: z.object({ echoed: z.string() }),
  access: { public: true },
  effects: { data: [], events: [], external: [], ai: false },
  exposeAs: ["mcp"],
  mcp: { description: "Echo" },
  async handler(_ctx, input) {
    return { echoed: input.message };
  },
});

describe("echo via MCP", () => {
  it("calls a registered capability", async () => {
    const { client, close } = await createTestMcpServer({ capabilities: [echo] });
    try {
      const result = await client.callTool({
        name: "echo",
        arguments: { message: "hi" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toEqual({ echoed: "hi" });
    } finally {
      await close();
    }
  });
});
```

### Options

```ts
createTestMcpServer({
  capabilities: [...],                              // required
  entities: [mcpTaskEntity, /* yours */],           // forwarded to createTestContext for tests that use ctx.data
  auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'mcp' },
  authAdapter?: McpServerConfig['authAdapter'],     // override the default (any Bearer accepted, or seed from `auth`)
  onCapabilityError?: McpServerConfig['onCapabilityError'],
  onMcpToolCall?: McpServerConfig['onMcpToolCall'], // for testing observability
  requestTimeoutMs?: number,
})
```

The default auth adapter accepts any `Bearer <anything>` header AND falls back to constructing an `AuthContext` from `opts.auth` when no header is present — so tests can call `client.callTool({...})` without manually injecting an `Authorization` header.

The test context (`createTestContext` from `@plumbus/core/testing`) is **shared across calls within a single server instance**, so an in-memory entity store keeps state across `tools/call` → `tasks/get` → `tasks/result`. This is required for MCP-task tests to work end-to-end.

## Testing observability

```ts
import type { McpToolCallInfo } from "@plumbus/mcp";

it("fires onMcpToolCall on success", async () => {
  const calls: McpToolCallInfo[] = [];
  const { client, close } = await createTestMcpServer({
    capabilities: [echo],
    onMcpToolCall: (info) => calls.push(info),
  });
  try {
    await client.callTool({ name: "echo", arguments: { message: "hi" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      capabilityName: "echo",
      status: "success",
      provider: "mcp",
    });
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await close();
  }
});
```

The hook fires for both inline `tools/call` and the background task path (for `kind: 'job'` + `_meta.taskMetadata`). Errors thrown inside the hook are caught and logged to stderr — they never fail the tool call.

## Testing MCP tasks end-to-end

```ts
import {
  CancelTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

it("runs a job through tasks/result", async () => {
  const { client, close } = await createTestMcpServer({
    capabilities: [slowJob],
    entities: [mcpTaskEntity],                      // REQUIRED for any kind:'job' over MCP
    auth: { userId: "u1", roles: ["user"], scopes: [], provider: "mcp" },
  });
  try {
    const create = await client.callTool({
      name: "slowJob",
      arguments: {},
      _meta: { taskMetadata: {} },
    } as any) as any;
    const taskId = create.task.taskId;

    // Poll
    let status = "working";
    for (let i = 0; i < 30 && status === "working"; i++) {
      const got = await client.request(
        { method: "tasks/get", params: { taskId } },
        GetTaskResultSchema,
      );
      status = got.status;
      if (status === "working") await new Promise((r) => setTimeout(r, 10));
    }
    expect(status).toBe("completed");

    const payload = await client.request(
      { method: "tasks/result", params: { taskId } },
      GetTaskPayloadResultSchema,
    );
    expect(payload.someField).toBe("expected value");
  } finally {
    await close();
  }
});
```

Use the SDK's `GetTaskResultSchema` / `GetTaskPayloadResultSchema` / `CancelTaskResultSchema` for the typed `client.request(...)` form. Cast `callTool({ _meta: ... } as any)` is acceptable — the typed `client.callTool` arg doesn't expose `_meta` yet.

## `mockMcpClient` — lower-level pairing

When you need to drive the server side manually:

```ts
import { mockMcpClient } from "@plumbus/mcp/testing";
import { createMcpServer } from "@plumbus/mcp";

const { client, clientTransport, serverTransport } = mockMcpClient();
const server = createMcpServer(config);
await server.connect(serverTransport);
await client.connect(clientTransport);
// ... drive manually ...
```

Use when `createTestMcpServer`'s opinionated defaults (default auth fallback, shared test ctx) get in the way.

## Don'ts

- **Don't forget `entities: [mcpTaskEntity]`** when testing `kind: 'job'` over MCP. The `tasks/*` handlers throw `McpTask entity not registered` without it.
- **Don't await `close()` inside the test body without a `try/finally`.** The transport leaks between tests otherwise.
- **Don't rely on parallel-test isolation of `taskAbortRegistry`.** The registry is module-scope; long-running test runs that call `tasks/cancel` may interact. Use distinct task IDs per test.

## See also

`docs/testing/testing-guide.md` and `docs/mcp/tasks-and-jobs.md` in the Plumbus monorepo for the conceptual model.
