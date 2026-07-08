# MCP Tasks and Jobs

Plumbus exposes `kind: 'job'` capabilities to AI agents using the MCP Tasks model: the client opts into task mode by carrying `taskMetadata` in the `tools/call` request, the server responds with a task handle instead of an inline result, and the client polls `tasks/get` (or consumes `notifications/tasks/status`) until completion.

**Opting in is the client's choice.** A `tools/call` for a `kind: 'job'` capability that **omits** `_meta.taskMetadata` runs through the inline `tools/call` path exactly like an `action` or `query` — the handler executes synchronously and the result returns inline. This matters because not every MCP client implements the tasks capability; older clients can still invoke job tools, they just block until the handler returns (and may time out under `requestTimeoutMs` for long jobs). Recommend `taskMetadata` for any client that supports it.

There is no separate `tasks/call` method — task mode is always `tools/call` with `_meta: { taskMetadata: {} }`. The object can be empty; no fields are required.

```ts
await client.callTool({
  name: 'reports.generateReport',
  arguments: { scope: 'q1' },
  _meta: { taskMetadata: {}, progressToken: 'report-1' },
});
```

See the [MCP Tasks specification](https://modelcontextprotocol.io/specification/tasks).

## Sequence

With `jobQueue` configured, execution moves to the worker after dispatch:

```
client                          server                          worker
  │  tools/call (_meta.taskMetadata)
  ├──────────────────────────────▶
  │                              │  createTask → mcp_task row
  │                              ├──▶ dispatchQueuedJob → jobs queue
  │  CreateTaskResult { taskId } │
  ◀──────────────────────────────┤
  │                              │              ◀── dequeue + executeCapability
```

Without `jobQueue`, the server executes in-process:

```
client                          server                          worker
  │  tools/call (_meta.taskMetadata)
  ├──────────────────────────────▶
  │                              │  createTask → mcp_task row
  │                              ├──▶ executeCapability (background)
  │  CreateTaskResult { taskId } │
  ◀──────────────────────────────┤
  │                              │              ◀── ctx.progress.report
  │  notifications/progress      │
  ◀──────────────────────────────┤
  │  tasks/get { taskId }        │
  ├──────────────────────────────▶
  │  Task { status: 'working' }  │
  ◀──────────────────────────────┤
  │                              │              ◀── handler returns
  │                              │  markStatus('completed')
  │  notifications/tasks/status  │
  ◀──────────────────────────────┤
  │  tasks/result { taskId }     │
  ├──────────────────────────────▶
  │  { ...handler output }       │
  ◀──────────────────────────────┤
```

`tasks/result` returns the handler's output object **directly** at the JSON-RPC result root (for example `{ url: '...' }`), not wrapped in a `payload` field. The diagram's last line is shorthand for that object.

Clients can poll `tasks/get` until `status` is terminal, or register `client.setNotificationHandler` for `notifications/tasks/status` (and `notifications/progress` when a `progressToken` was sent on the original `tools/call`).

## Shared Jobs Queue

When `jobQueue` is set on `McpServerConfig`, MCP task dispatch for `kind: 'job'` capabilities uses the same path as HTTP job routes — `dispatchQueuedJob` creates a `job_executions` row and publishes to the shared jobs queue. A worker process must be running to dequeue and execute.

```typescript
import { createMcpServer } from '@plumbus/mcp';
import { resolveRuntimeQueues } from '@plumbus/core';

const queues = await resolveRuntimeQueues(config);

const server = createMcpServer({
  registry,
  db,
  authAdapter,
  createDependencies,
  jobQueue: queues.jobs,
});
```

| `jobQueue` | Behavior |
|------------|----------|
| Set | Async dispatch — worker dequeues, updates `job_executions`, syncs `mcp_task` row on completion |
| Omitted | In-process execution (backward compatible for dev and colocated `plumbus start`) |

Colocated `plumbus start` / `plumbus dev` wire `jobQueue` for **HTTP** whenever job capabilities exist (in-memory or Redis). `plumbus mcp serve` passes `jobQueue` only when Redis is configured (`queues.isDurable`); otherwise MCP jobs run in-process. Split deployments (`PLUMBUS_RUNTIME_ROLE=api` + `plumbus worker`) require Redis and a running worker for async MCP jobs.

When jobs run in a worker process, `@plumbus/mcp`'s `createMcpJobCompletionSync` updates the `mcp_task` row on completion — install `@plumbus/mcp` in worker images that serve MCP jobs.

## Wiring

Apps that expose `kind: 'job'` capabilities via MCP must register `mcpTaskEntity` in their entity list:

```ts
import { mcpTaskEntity } from '@plumbus/mcp';

export const entities = [
  // ... your own entities ...
  mcpTaskEntity,
];
```

Then define the job capability normally:

```ts
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const generateReport = defineCapability({
  name: 'generateReport',
  kind: 'job',
  domain: 'reports',
  description: 'Generate a PDF report (slow)',
  input: z.object({ scope: z.string() }),
  output: z.object({ url: z.string() }),
  access: { roles: ['user'], tenantScoped: true },
  effects: { data: [], events: [], external: ['storage'], ai: false },
  exposeAs: ['mcp'],
  mcp: { description: 'Generate a report; returns a download URL.' },
  async handler(ctx, input) {
    ctx.progress?.report({ progress: 0, total: 100, message: 'Starting' });
    // ... do work, calling ctx.progress.report({...}) periodically ...
    return { url: '...' };
  },
});
```

## `ctx.progress.report`

Inside a `kind: 'job'` handler called via MCP with task metadata on the **in-process** path, `ctx.progress` is set. Calling `ctx.progress.report({ progress, total?, message? })`:

1. Persists the latest progress on the `mcp_task` row.
2. Emits `notifications/progress` to the MCP client with the original `progressToken` (when provided).

On the **queued-worker** path (`jobQueue`/Redis + `plumbus worker`), `ctx.progress` is **undefined** in the handler and no MCP notifications are emitted. Clients must poll `tasks/get` (and `tasks/result`) to observe progress and completion.

When the handler is invoked through HTTP (the existing 202 + jobId path) or via direct `runCapability` in tests, `ctx.progress` is also `undefined`. Always use optional chaining: `ctx.progress?.report({...})`.

If the client does **not** send `_meta.progressToken` on the original `tools/call`, `notifications/progress` is not emitted — progress is still persisted on the `mcp_task` row, but the client must poll `tasks/get` to observe it.

## Cancellation

`tasks/cancel` sets the task `status='cancelled'` and aborts the running handler via `ctx.signal`. Handlers that honor cancellation check `ctx.signal?.aborted` between work units and return early. The runtime discards the final return value of a cancelled handler.

## Persistence and TTL

Task rows live in the `mcp_task` table. `ttlMs` is reserved for future cleanup; v1 keeps tasks indefinitely. Apps that need cleanup can run a periodic job that deletes `mcp_task` rows older than N days.

## See also

- [Overview](./overview.md) — feature matrix
- [Expose a capability](./expose-a-capability.md) — including `kind: 'job'` examples
- [Agent authentication](./agent-authentication.md) — task ownership scoping
