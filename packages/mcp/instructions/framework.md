# @plumbus/mcp — Framework

`@plumbus/mcp` is the **MCP runtime** for Plumbus apps. It serves capabilities marked `exposeAs: ['mcp']` to AI agents over stdio or Streamable HTTP. It is an **optional peer** of `@plumbus/core` (version-locked `0.5.x || 0.6.x`).

**`package.json` peer (framework releases):** `"@plumbus/core": "0.5.x || 0.6.x"` — copy literally; see `packages/plumbus-core/instructions/peer-dependencies.md`.

## Package boundary

| Concern | Owned by |
|---|---|
| `exposeAs` field on `defineCapability` | `@plumbus/core` |
| `plumbus generate` MCP manifest + skill files | `@plumbus/core` |
| `plumbus mcp serve` / `list-tools` / `mcp generate` CLI commands | `@plumbus/core` |
| `createMcpServer` runtime, request handlers, transports | `@plumbus/mcp` |
| `mcpTaskEntity` + task-store for `kind: 'job'` | `@plumbus/mcp` |
| `createTestMcpServer` / `mockMcpClient` test helpers | `@plumbus/mcp/testing` |
| `createMcpAuthAdapter` | `@plumbus/mcp` |

This split lets apps generate the MCP manifest without installing the runtime, and lets the runtime stay swappable.

## Public exports

```ts
// from '@plumbus/mcp'
createMcpServer(config, options?)          // builds an MCP Server from a CapabilityRegistry
McpServerConfig                            // { registry, db, authAdapter, createDependencies, onCapabilityError?, onMcpToolCall?, requestTimeoutMs? }
McpToolCallInfo                            // payload passed to onMcpToolCall
CreateMcpServerOptions                     // { name?, version? }

createMcpAuthAdapter({ agents, envToken })  // AuthAdapter that maps Bearer/env tokens to AuthContext
resolveMcpAgentToken(header, agents, env)
parseBearerToken(authorizationHeader)

registerMcpOnFastify(app, config, opts?)   // mount MCP HTTP transport on an existing Fastify app
startHttpServer(opts)                       // standalone Fastify + MCP HTTP server
startStdioServer({ server })                // run an MCP server over stdio
RegisterMcpOnFastifyOptions, StartHttpServerOptions

mcpTaskEntity                               // register in app entity list when exposing kind:'job' via MCP

// from '@plumbus/mcp/testing'
createTestMcpServer({ capabilities, entities?, auth?, onMcpToolCall?, ... })
mockMcpClient()                             // pre-paired client + transport, unconnected
```

## File map (`src/`)

```
src/
├── index.ts                    # public barrel
├── server.ts                   # createMcpServer — registers ListTools/CallTool + 4 task handlers
├── types.ts                    # McpServerConfig, McpToolCallInfo
├── auth/
│   ├── mcp-auth-adapter.ts     # createMcpAuthAdapter
│   ├── parse-bearer.ts         # parseBearerToken
│   └── resolve-agent-token.ts  # map-key lookup against mcp.agents
├── transports/
│   ├── http.ts                 # registerMcpOnFastify + startHttpServer + discovery route
│   └── stdio.ts                # startStdioServer
├── tasks/
│   ├── mcp-task-entity.ts      # mcpTaskEntity (register in app entity list)
│   └── task-store.ts           # createTask, markStatus, recordProgress, getByIdScoped
└── testing/
    ├── create-test-mcp-server.ts
    └── mock-mcp-client.ts
```

## Critical rules

1. **Capability runtime is unchanged.** Every MCP `tools/call` goes through the same `executeCapability` pipeline as HTTP — validation, access policy, audit. The MCP layer is a thin adapter; it never re-implements those.
2. **Per-call `ExecutionContext`.** `createDependencies(auth, { bypassTenantScope })` is called once per request; the resulting `ctx` is not reused across concurrent calls.
3. **`@plumbus/core` MUST NOT import from `@plumbus/mcp`.** The dependency points one way. CLI checks in core (`plumbus doctor`'s MCP checks) inspect `node_modules/@plumbus/mcp/package.json` via the filesystem only — no symbol imports.
4. **`access.public: true` + `exposeAs: ['mcp']` is a destructive footgun.** `plumbus doctor` fails on it. Never combine the two on a write/job capability.
5. **`bypassTenantScope` mirrors HTTP.** When `access.tenantScoped === false`, the runtime calls `createDependencies(auth, { bypassTenantScope: true })`. Tenant-scoped capabilities (the default) still enforce tenant isolation.
6. **Background task path is independent.** A task-augmented `tools/call` returns inline with `{ task: { taskId, status: 'working', ... } }`; the actual `executeCapability` runs in a separate background `ExecutionContext` with its own `ctx.signal` (the AbortController) and `ctx.progress`. State persists to the `mcp_task` row.

## Where to look for more

Conceptual reference and the full spec coverage matrix: `docs/mcp/` in the Plumbus monorepo (`overview.md`, `expose-a-capability.md`, `agent-authentication.md`, `transports.md`, `tasks-and-jobs.md`, `skill-files.md`).
