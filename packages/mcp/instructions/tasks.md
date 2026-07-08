# Recipe: Long-running jobs over MCP (Tasks)

`kind: 'job'` capabilities can be exposed to AI agents via the MCP Tasks model. A client opts into task mode by carrying `_meta.taskMetadata` on a `tools/call`; the server returns a task handle instead of an inline result, runs the handler in the background, and exposes `tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list`.

## When to use

- Long-running operations that exceed `requestTimeoutMs` (report generation, batch processing, slow external calls).
- Operations where the agent benefits from polling status or receiving progress notifications.
- Operations that need cooperative cancellation.

For synchronous queries/actions, stick with regular `tools/call` — see [expose-a-capability.md](./expose-a-capability.md).

## 1. Register `mcpTaskEntity`

**Required.** Without this, `tasks/*` requests fail with `McpTask entity not registered — add mcpTaskEntity to the app entity list`.

```ts
// app/entities/index.ts
import { mcpTaskEntity } from "@plumbus/mcp";

export const entities = [
  // ... your own entities ...
  mcpTaskEntity,
];
```

Then run `plumbus migrate generate && plumbus migrate apply` so the `mcp_task` table exists.

## 2. Define the job capability

```ts
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const generateReport = defineCapability({
  name: "generateReport",
  kind: "job",
  domain: "reports",
  description: "Generate a PDF report (slow)",
  input: z.object({ scope: z.string() }),
  output: z.object({ url: z.string() }),
  access: { roles: ["user"], tenantScoped: true },
  effects: { data: [], events: [], external: ["storage"], ai: false },
  exposeAs: ["mcp"],
  mcp: { description: "Generate a report; returns a download URL when complete." },
  async handler(ctx, input) {
    ctx.progress?.report({ progress: 0, total: 100, message: "Starting" });
    for (let i = 1; i <= 100; i++) {
      if (ctx.signal?.aborted) return { url: "" };   // honor cancellation
      // ... do work ...
      ctx.progress?.report({ progress: i, total: 100 });
    }
    return { url: "https://.../report.pdf" };
  },
});
```

Use `ctx.progress?.report({...})` to emit progress and persist the latest value on the task row. Use `ctx.signal?.aborted` to honor `tasks/cancel`.

## 3. Client-side: opt into task mode

```ts
const result = await client.callTool({
  name: "reports.generateReport",
  arguments: { scope: "Q4" },
  _meta: { taskMetadata: {}, progressToken: "report-1" },
} as any);
// result = { task: { taskId, status: 'working', createdAt, lastUpdatedAt, ttl } }
```

- **`taskMetadata` is an empty object** — no required fields. Its mere presence flips the server into task mode.
- **`progressToken` is optional but required for `notifications/progress`.** If omitted, progress is still persisted on the `mcp_task` row but `notifications/progress` is NOT emitted; the client must poll `tasks/get` to observe progress.
- **A `kind: 'job'` capability called WITHOUT `_meta.taskMetadata`** runs synchronously through the inline path — exactly like an action. Useful for backward compat with clients that don't understand the tasks capability, but may time out under `requestTimeoutMs`.

## 4. Poll or subscribe

Either poll `tasks/get` (any client) or register a notification handler on the MCP SDK Client:

```ts
// Poll
const task = await client.request(
  { method: "tasks/get", params: { taskId } },
  GetTaskResultSchema
);
// task = { taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttl }

// Subscribe (MCP SDK)
client.fallbackNotificationHandler = async (notification) => {
  if (notification.method === "notifications/tasks/status") { /* ... */ }
  if (notification.method === "notifications/progress")    { /* ... */ }
};
```

`notifications/tasks/status` fires on state transitions (`working → completed | failed | cancelled`) on the **in-process** task path. `notifications/progress` fires per `ctx.progress.report` when the client supplied `progressToken`.

On the **queued-worker** path (`jobQueue`/Redis + `plumbus worker`), handlers have no `ctx.progress` and **no MCP notifications** are emitted — poll `tasks/get` and `tasks/result` instead.

## 5. Fetch the result

```ts
const payload = await client.request(
  { method: "tasks/result", params: { taskId } },
  GetTaskPayloadResultSchema
);
// payload is the handler's output object spread at the root — NOT wrapped in { payload: ... }
// For generateReport above: payload = { url: 'https://.../report.pdf' }
```

If `task.status !== 'completed'`, `tasks/result` throws `task.not_completed: status is <status>`. Always check `status === 'completed'` first.

## 6. Cancel

```ts
const cancelled = await client.request(
  { method: "tasks/cancel", params: { taskId } },
  CancelTaskResultSchema
);
```

`tasks/cancel` marks `status='cancelled'` in the DB and aborts the in-process handler via `ctx.signal`. **The handler's final return value is discarded** — even if it completes a millisecond later, the result will not be visible via `tasks/result`. Capabilities that need to clean up on cancel should do so before returning when `ctx.signal?.aborted` is `true`.

## Rules

- **Register `mcpTaskEntity` exactly once.** Apps that forget get a typed `McpTask entity not registered` error at first `tasks/*` call.
- **Use optional chaining for `ctx.progress`.** It is `undefined` when the handler runs outside an MCP task (HTTP 202 path, direct `runCapability` in tests). Always `ctx.progress?.report({ ... })`.
- **Tasks are scoped to the caller.** Every `tasks/get | result | cancel | list` re-authenticates and rejects requests where `task.userId !== auth.userId`. A leaked token grants only the task scope of the original caller.
- **Don't store partial results in `ctx.audit` for retrieval.** The `mcp_task` row is the canonical source. Audit is for the audit trail, not state.

## Don'ts

- Don't put `kind: 'eventHandler'` on MCP. Event handlers have no caller surface; rejected at `defineCapability()` time.
- Don't await long-running work synchronously in a non-job capability if the operation can exceed `requestTimeoutMs`. Make it a job.
- Don't reuse the inline `tools/call` `ctx` in the background — the runtime creates a fresh `bgCtx` with its own `signal` and `progress`. Tests covering both paths should reflect this.
- Don't rely on `notifications/tasks/status` being delivered to multiple clients — notifications are session-scoped (the same MCP server instance).

## Shared jobs queue (split deploy, 0.5+)

Colocated `plumbus start` / `plumbus dev` (`PLUMBUS_RUNTIME_ROLE=all`) runs MCP and workers in one process — task dispatch behaves as before.

**HTTP vs MCP (default colocated):** HTTP job routes return **202** and use `jobQueue` whenever job capabilities exist, even with in-memory queues. MCP only receives `jobQueue` when Redis is durable.

When **MCP runs separately from workers** (split topology) and Redis is configured:

- `plumbus mcp serve` passes `jobQueue` to `createMcpServer` when `resolveRuntimeQueues` returns `isDurable: true`.
- `kind: 'job'` tools enqueue to the shared **jobs** queue; a `plumbus worker` process dequeues and executes.
- The worker pool auto-imports `createMcpJobCompletionSync` from `@plumbus/mcp` when installed, updating `mcp_task` rows when jobs complete off the MCP process.

Without Redis, MCP jobs stay **in-process** (no `jobQueue`). Install `redis` and run `plumbus worker start` for split deploys. See `docs/upgrading-workers.md` and `docs/mcp/tasks-and-jobs.md`.

## Module-scope abort registry

The runtime keeps `taskAbortRegistry: Map<string, AbortController>` at module scope. This is acceptable for the supported single-process / pinned-LB deployment topology. Multi-instance deployments with shared task state need a per-server registry — tracked as a future v0.x follow-up.

## Conceptual deep-dive

Sequence diagram, full lifecycle, and design rationale: `docs/mcp/tasks-and-jobs.md` in the Plumbus monorepo.
