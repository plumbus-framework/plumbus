# @plumbus/mcp

> **Serve your existing [Plumbus](https://github.com/plumbus-framework/plumbus) capabilities to AI agents over MCP.** Mark a capability with `exposeAs: ['mcp']`, configure agent tokens, and it becomes a callable tool for Claude Desktop, Cursor, custom agent runners — with the **same validation, access policies, and audit pipeline** as your HTTP routes.

[![npm](https://img.shields.io/npm/v/@plumbus/mcp.svg)](https://www.npmjs.com/package/@plumbus/mcp)
[![license](https://img.shields.io/npm/l/@plumbus/mcp.svg)](./LICENSE)
[![peer: @plumbus/core 0.5.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.5.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![MCP spec: tools + tasks](https://img.shields.io/badge/MCP-tools%20%2B%20tasks-7c5cff)](https://modelcontextprotocol.io)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare your app's primitives — capabilities (queries/actions/jobs/event handlers), entities, events, flows, prompts, translations — through `define*()` functions. The framework gives you HTTP routes, Zod validation, deny-by-default security, audit, governance, and AI integration out of the box.

`@plumbus/mcp` is the **MCP (Model Context Protocol) runtime** for that framework. Mark a capability with `exposeAs: ['mcp']`, configure an agent token, and the same handler that backs your `POST /api/billing/get-refund` HTTP route is now a callable MCP tool for Claude Desktop, Cursor, or any MCP client — without writing duplicate code, duplicate auth, or duplicate audit.

If you're not using Plumbus, this package can't be used in isolation. The MCP runtime composes on the framework's `executeCapability` pipeline; it doesn't re-implement tool dispatch from scratch.

## Why?

If you've ever exposed handlers over MCP, you've probably written something like:

- A second auth layer for agent tokens
- A second validation layer for tool inputs
- A second audit hook so you can see what agents did
- A bespoke task model for long-running operations
- A bespoke notification system for progress

Plumbus already has all of that for HTTP. This package routes it through MCP. **One handler, two protocols, one audit log.**

## What you get

| Surface | What it does |
|---|---|
| **`tools/list`, `tools/call`** | Every capability with `exposeAs: ['mcp']` (kinds `query`, `action`, `job`) becomes an MCP tool. Inputs are Zod-validated; access policy enforced; audit recorded. |
| **Tasks** (`tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list`) | `kind: 'job'` capabilities run as long-running MCP tasks. Clients opt in by sending `_meta.taskMetadata` on `tools/call`. State persists in `mcp_task` (a Plumbus entity). |
| **Progress notifications** | Job handlers call `ctx.progress?.report(...)` → server emits `notifications/progress`. Task state transitions emit `notifications/tasks/status`. |
| **Authentication** | `createMcpAuthAdapter` maps `mcp.agents` bearer tokens → `AuthContext` with `provider: 'mcp'`. Tenant scoping mirrors the HTTP `bypassTenantScope` rule. |
| **Transports** | stdio (Claude Desktop, Cursor) and Streamable HTTP. Discovery route at `GET /mcp/discovery` returns the manifest + auth scheme. |
| **Observability** | `McpServerConfig.onMcpToolCall` fires per-tool-call (inline + task paths) with `{ capabilityName, durationMs, status, errorCode?, userId?, tenantId?, provider }`. Wire to Datadog, Prometheus, OTel, etc. |
| **Test helpers** (`@plumbus/mcp/testing`) | `createTestMcpServer` + `mockMcpClient` — pre-connected client/server over `InMemoryTransport` for vitest integration tests. |
| **Doctor checks** | `plumbus doctor` validates `mcp.agents` configuration, fails on `access.public: true` + `exposeAs: ['mcp']`, warns on stale generated skill files. |

## Status

Optional peer of `@plumbus/core` (version-locked `0.5.x`). Implements the MCP transport layer, auth model, tasks, and the per-tool-call observability hook. OAuth, resources, prompts, sampling, elicitation, completions, roots, and logging are out of scope — see [MCP spec coverage](#mcp-spec-coverage).

## Install

```bash
pnpm add @plumbus/mcp
```

`@plumbus/core` works without `@plumbus/mcp` — `plumbus generate` still produces the MCP manifest and skill files. Install this package only when you want to actually **serve** capabilities to agents. `plumbus mcp serve` prints an install hint if the runtime is missing.

## Quick start

### 1. Mark a capability for MCP

```typescript
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const getRefund = defineCapability({
  name: 'getRefund',
  kind: 'query',
  domain: 'billing',
  description: 'Fetch a refund by id',

  exposeAs: ['mcp'],
  mcp: { description: 'Look up a refund for billing support agents' },

  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), amount: z.number() }),
  access: { serviceAccounts: ['billing-agent'], tenantScoped: true },
  effects: { data: ['Refund'], events: [], external: [], ai: false },
  handler: async (ctx, { id }) => ctx.data.Refund.byId(id),
});
```

### 2. Configure agent tokens

```typescript
// plumbus.config.ts
export default {
  mcp: {
    agents: {
      'sk-billing-agent-7c2f9': {       // map key IS the bearer token verbatim
        serviceAccountId: 'billing-agent',
        scopes: ['billing:read'],
        tenantId: 'tenant-1',           // optional
      },
    },
  },
};
```

There is no separate "secret" field — the map key **is** the token. Pick a high-entropy string.

### 3. (For long-running jobs only) Register `mcpTaskEntity`

```ts
import { mcpTaskEntity } from '@plumbus/mcp';
export const entities = [/* your entities */, mcpTaskEntity];
```

Then `plumbus migrate generate && plumbus migrate apply`.

### 4. Serve

```bash
plumbus mcp serve --stdio                # Claude Desktop, Cursor, local agents
plumbus mcp serve --http --port $PLUMBUS_MCP_PORT   # remote agents via Streamable HTTP
plumbus mcp list-tools                   # debug: list exposed tools
```

For embedding in an existing Fastify app:

```ts
import { registerMcpOnFastify } from '@plumbus/mcp';
import { onRoutesRegistered } from '@plumbus/core';

onRoutesRegistered(async (app, routeConfig) => {
  await registerMcpOnFastify(app, {
    registry,
    db: routeConfig.db,
    authAdapter: routeConfig.authAdapter,
    createDependencies: routeConfig.createDependencies,
  });
});
```

## How requests flow

```
client tools/call
       │
       ▼
 authAdapter.authenticate(token)            ← map-key lookup against mcp.agents
       │
       ▼
 createDependencies(auth, { bypassTenantScope })
       │
       ▼
 executeCapability(cap, ctx, args)          ← full Plumbus pipeline:
       │                                       Zod validation → access policy
       │                                       → handler → audit → output validation
       ▼
 CapabilityResult
       │
       ├─→ inline tools/call               → CallToolResult (text content)
       └─→ task-augmented (kind:'job' + _meta.taskMetadata)
              │
              ▼
         CreateTaskResult                   ← clients poll tasks/get / tasks/result
                                              ← server emits notifications/{progress, tasks/status}
```

This package doesn't re-implement validation, access policy, or audit — they all run inside `executeCapability`, identical to the HTTP path.

## Public API

| Export | Purpose |
|---|---|
| `createMcpServer(config, options?)` | Build an MCP `Server` from a `CapabilityRegistry`. Registers `tools/list`, `tools/call`, and 4 `tasks/*` handlers. |
| `McpServerConfig`, `McpToolCallInfo` | Server config + observability payload shapes. |
| `startStdioServer({ server })` | Run an MCP server on stdio. |
| `startHttpServer({ config, port, host })` | Standalone Fastify + Streamable HTTP MCP server. |
| `registerMcpOnFastify(app, config, mcpOptions?)` | Mount on existing Fastify (`path`, `discoveryPath`, `stateless`, `requireDiscoveryAuth`). |
| `createMcpAuthAdapter({ agents, envToken? })` | `AuthAdapter` mapping bearer tokens → `AuthContext` with `provider: 'mcp'`. |
| `resolveMcpAgentToken(header, agents, envToken)` | Direct token-resolution helper. |
| `parseBearerToken(header)` | Extract the bearer value from an `Authorization` header. |
| `mcpTaskEntity` | Entity for MCP task storage — register in the app entity list when exposing `kind: 'job'` via MCP. |
| `createTestMcpServer`, `mockMcpClient` (from `@plumbus/mcp/testing`) | Test helpers — pre-connected client + server over `InMemoryTransport`. |

## Observability

```ts
const config: McpServerConfig = {
  // ... existing fields
  onMcpToolCall: (info) => {
    metrics.histogram('mcp_tool_call_ms', info.durationMs, {
      capability: info.capabilityName,
      domain: info.domain,
      status: info.status,             // 'success' | 'error'
    });
  },
};
```

Fires on both the inline `tools/call` and the background task path. Fire-and-forget — hook errors are logged to stderr and never propagate to the client. Mirrors `onAICostRecorded` from `@plumbus/core`.

## Key gotchas

- **`mcp.agents` map key IS the bearer token.** Verbatim. No separate "secret" field. Pick a high-entropy string and treat it like an API key.
- **Empty `mcp.agents` triggers an anonymous fallback.** `plumbus mcp serve` falls back to the JWT adapter, and unauthenticated calls resolve to an anonymous `AuthContext` — only `access.public: true` capabilities execute. `plumbus doctor` warns on this combination.
- **`access.public: true` + `exposeAs: ['mcp']` on a destructive capability** is a security footgun. `plumbus doctor` fails on the combo. Never ship this.
- **Apps that expose `kind: 'job'` MUST register `mcpTaskEntity`.** Otherwise `tasks/*` requests throw `McpTask entity not registered`.
- **`kind: 'eventHandler'` cannot be MCP-exposed.** Rejected at `defineCapability()` time — event handlers have no caller surface.
- **`onMcpToolCall` on the task path** fires from a `finally` block after the background handler resolves; `durationMs` reflects total handler time, not the `tools/call` response time.

## MCP spec coverage

| Feature | Status | Notes |
|---|---|---|
| Tools — `tools/list`, `tools/call` | Supported | `query`, `action`, `job` kinds. |
| Tasks — `tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list` | Supported | For `kind: 'job'` capabilities; persisted in `mcp_task`. |
| `notifications/progress`, `notifications/tasks/status` | Supported | Progress requires `_meta.progressToken` from the client. |
| Observability — `onMcpToolCall` hook | Supported | Both inline and task paths. |
| Resources, Prompts, Sampling, Elicitation, Completions, Roots, Logging | Deferred | Tracked for v0.3+. |
| OAuth authorization server | Deferred | Bearer-only auth in v0.x. |

Full matrix and rationale: [`docs/mcp/overview.md`](../../docs/mcp/overview.md#mcp-spec-coverage).

## Documentation

- **Concepts and reference** (in the monorepo): [`docs/mcp/`](../../docs/mcp/)
  - [`overview.md`](../../docs/mcp/overview.md) — spec coverage matrix, packages, workflow
  - [`expose-a-capability.md`](../../docs/mcp/expose-a-capability.md) — opt-in, annotations, governance
  - [`agent-authentication.md`](../../docs/mcp/agent-authentication.md) — token resolution, anonymous fallback, task ownership
  - [`transports.md`](../../docs/mcp/transports.md) — stdio + HTTP, `registerMcpOnFastify`, `onMcpToolCall`
  - [`tasks-and-jobs.md`](../../docs/mcp/tasks-and-jobs.md) — `kind: 'job'` over MCP Tasks (sequence diagram, wiring, cancellation)
  - [`skill-files.md`](../../docs/mcp/skill-files.md) — generated `.plumbus/generated/skills/` artifacts
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/mcp/instructions/`):
  - [`instructions/framework.md`](./instructions/framework.md) — package boundary, public exports, critical rules
  - [`instructions/expose-a-capability.md`](./instructions/expose-a-capability.md) — full recipe with agent token config
  - [`instructions/tasks.md`](./instructions/tasks.md) — `kind: 'job'`, `ctx.progress`, cancellation
  - [`instructions/testing.md`](./instructions/testing.md) — `@plumbus/mcp/testing`

## The Plumbus ecosystem

`@plumbus/mcp` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **MCP specification** — [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
