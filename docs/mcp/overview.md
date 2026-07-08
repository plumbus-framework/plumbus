# MCP Overview

Plumbus capabilities are the contract for business logic. **HTTP** exposes them to browsers and REST clients; **MCP** (Model Context Protocol) exposes selected capabilities to external AI agents as tools.

MCP is **not** a new primitive. It is transport, discovery, and agent authentication on top of the existing `CapabilityContract` and `executeCapability()` pipeline.

## When to use MCP

| Surface | Best for |
|---------|----------|
| HTTP (`plumbus start`) | Humans, web apps, mobile, integrations expecting REST |
| MCP (`plumbus mcp serve`) | Claude Desktop, Cursor, custom agent runners, headless automation |

Use MCP when an agent should call your app with the same validation, access policies, and audit trail as HTTP — without duplicating handlers.

## Opt-in (100% backward compatible)

Capabilities are HTTP-only by default. To expose a tool:

```typescript
defineCapability({
  name: "getRefund",
  kind: "query",
  domain: "billing",
  description: "Fetch refund by id",
  exposeAs: ["mcp"],
  mcp: {
    description: "Look up a refund for billing support agents",
    dangerous: false,
    agentTags: ["billing", "support"],
  },
  // ...input, output, access, effects, handler
});
```

- **`exposeAs: ['mcp']`** is the only opt-in path (no tag-based exposure).
- **`kind: 'job'`** is exposed via MCP Tasks (see [tasks-and-jobs.md](./tasks-and-jobs.md)). **`kind: 'eventHandler'`** cannot be MCP-exposed — event handlers have no caller surface.
- `@plumbus/core` does not install `@plumbus/mcp`; you opt in once per app by installing the runtime (see below).

## Packages

| Package | Role | Install |
|---------|------|---------|
| `@plumbus/core` | Contract fields, `plumbus generate` manifest/skills, CLI `plumbus mcp *` | Always |
| `@plumbus/mcp` | Runtime server (stdio + Streamable HTTP), `createMcpAuthAdapter` | `pnpm add @plumbus/mcp` when you want to serve agents |

`@plumbus/mcp` is an optional peer of `@plumbus/core` (version-locked `0.5.x || 0.6.x`). `plumbus mcp serve` prints an install hint if the package is missing.

## Two reading paths

- **Conceptual reference** (the files in this folder): overview (here), [expose-a-capability](./expose-a-capability.md), [agent-authentication](./agent-authentication.md), [transports](./transports.md), [tasks-and-jobs](./tasks-and-jobs.md), [skill-files](./skill-files.md).
- **Agent recipes** at [`packages/mcp/instructions/`](../../packages/mcp/instructions/) (ships in the npm tarball at `node_modules/@plumbus/mcp/instructions/`):
  - [`instructions/framework.md`](../../packages/mcp/instructions/framework.md) — package boundary (core vs mcp), public exports, file map, critical rules
  - [`instructions/expose-a-capability.md`](../../packages/mcp/instructions/expose-a-capability.md) — recipe for `exposeAs: ['mcp']` + agent token config
  - [`instructions/tasks.md`](../../packages/mcp/instructions/tasks.md) — `kind: 'job'` via MCP Tasks (`mcpTaskEntity`, `ctx.progress`, cancellation)
  - [`instructions/testing.md`](../../packages/mcp/instructions/testing.md) — `@plumbus/mcp/testing` helpers

The Plumbus-core surface (the `exposeAs` field and `plumbus mcp *` CLI) is also covered in [`node_modules/@plumbus/core/instructions/mcp.md`](../../packages/plumbus-core/instructions/mcp.md).

## Workflow

1. Mark capabilities with `exposeAs: ['mcp']` and configure `access.serviceAccounts` for agents.
2. `plumbus generate` → `.plumbus/generated/mcp-manifest.json` and `skills/<domain>/<name>.md`. (No `@plumbus/mcp` needed for generation.)
3. `pnpm add @plumbus/mcp` once per app — required to start an MCP server.
4. Configure `mcp.agents` in `plumbus.config.ts` (see [agent-authentication.md](./agent-authentication.md)).
5. `plumbus mcp serve --stdio` or `plumbus mcp serve --http --port 3001`.

`tools/list` returns all MCP-exposed tools with **canonical** names (`<domain>.<capabilityName>`); **access is enforced on `tools/call`** (scope-filtered listing is deferred). See [expose-a-capability](./expose-a-capability.md#tool-identity) and [upgrading capability names](../upgrading-capability-names.md).

## Related docs

- [Expose a capability](./expose-a-capability.md)
- [Agent authentication](./agent-authentication.md)
- [Transports](./transports.md)
- [Skill files](./skill-files.md)
- [Tasks and jobs](./tasks-and-jobs.md)

---

## MCP spec coverage

Plumbus implements a subset of the MCP spec. The matrix documents what is supported and what is deferred. Items marked deferred can be added incrementally without breaking changes.

| Spec feature | Status | Notes |
|---|---|---|
| Tools — `tools/list` | Supported | All `query` / `action` capabilities with `exposeAs: ['mcp']`. |
| Tools — `tools/call` | Supported | Runs through the standard `executeCapability` pipeline. |
| Observability — `onMcpToolCall` | Supported | Optional `McpServerConfig` hook after each `tools/call` (inline and task paths). See [transports.md → Per-tool-call observability](./transports.md#per-tool-call-observability--onmcptoolcall). |
| Tasks — `tools/call` with task metadata | Supported | No separate `tasks/call` RPC — same `tools/call` with `_meta.taskMetadata` ({} is enough). `kind: 'job'` capabilities return a task instead of an inline result. |
| Tasks — `tasks/get` / `tasks/result` / `tasks/cancel` / `tasks/list` | Supported | Persisted in the `mcp_task` entity. |
| `notifications/progress` | Supported (in-process path) | Emitted when a job handler calls `ctx.progress.report(...)` on the **in-process** task path. On the queued-worker path (`jobQueue`/Redis + `plumbus worker`), `ctx.progress` is undefined and no progress notifications are emitted — clients poll `tasks/get`. |
| `notifications/tasks/status` | Supported (in-process path) | Emitted on task state transitions for in-process tasks. **Not emitted** for queued-worker jobs — poll `tasks/get` instead. |
| Resources — `resources/list` / `resources/read` | Deferred | Plumbus entities and translations would map here. |
| Prompts — `prompts/list` / `prompts/get` | Deferred | `definePrompt` outputs would map here. |
| Sampling — `sampling/createMessage` | Deferred | Server→client LLM access. |
| Elicitation — `elicitation/request` | Deferred | Server-requested user input mid-tool-call. |
| Completions — `completion/complete` | Deferred | Argument autocompletion for tool inputs. |
| Roots — `roots/list` | Deferred | Filesystem roots from the client. |
| Logging — `logging/setLevel` / `notifications/message` | Deferred | Server logging to the client. |
| List-changed notifications | Deferred | Server-pushed catalog change events. |

End-to-end: [tasks-and-jobs.md](./tasks-and-jobs.md).
