# @plumbus/mcp

MCP (Model Context Protocol) runtime for the [Plumbus framework](https://github.com/plumbus-framework/plumbus). Serves Plumbus capabilities marked with `exposeAs: ['mcp']` to AI agents as MCP tools — over stdio or Streamable HTTP — with the same validation, access policies, and audit pipeline as Plumbus HTTP routes.

## Install

```bash
pnpm add @plumbus/mcp
```

This package is an **optional peer dependency** of `@plumbus/core` (version-locked `0.4.x`). `@plumbus/core` works without it; install this only when you want to expose capabilities to agents.

## Quick start

In a Plumbus app, mark a capability for MCP exposure:

```typescript
defineCapability({
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

Configure agent tokens in `plumbus.config.ts`:

```typescript
export default {
  mcp: {
    agents: {
      'opaque-token-from-agent-runtime': {
        serviceAccountId: 'billing-agent',
        scopes: ['billing:read'],
        tenantId: 'tenant-1',
      },
    },
  },
};
```

Apps that expose `kind: 'job'` capabilities via MCP must register `mcpTaskEntity`:

```ts
import { mcpTaskEntity } from '@plumbus/mcp';
export const entities = [/* your entities */, mcpTaskEntity];
```

Run an MCP server:

```bash
plumbus mcp serve --stdio                  # for Claude Desktop, Cursor, etc.
plumbus mcp serve --http --port 3001       # for remote agents
```

## Public API

| Export | Purpose |
|--------|---------|
| `createMcpServer(config)` | Build an MCP `Server` from a `CapabilityRegistry` |
| `startStdioServer({ server })` | Run an MCP server on stdio |
| `startHttpServer({ config, port, host })` | Run a Fastify-backed Streamable HTTP MCP server with `/mcp` + `/mcp/discovery` |
| `registerMcpOnFastify(app, config, mcpOptions?)` | Mount MCP routes on an existing Fastify instance (`path`, `discoveryPath`, `stateless`, `requireDiscoveryAuth`) |
| `createMcpAuthAdapter({ agents })` | Build an `AuthAdapter` that maps Bearer tokens to Plumbus `AuthContext` with `provider: 'mcp'` |
| `resolveMcpAgentToken(header, agents, envToken)` | Resolve a token from the `Authorization` header or `PLUMBUS_MCP_TOKEN` env |
| `parseBearerToken(header)` | Extract the bearer value from an `Authorization` header |
| `mcpTaskEntity` | Entity for MCP task storage — register in the app entity list when exposing `kind: 'job'` via MCP |
| `createTestMcpServer` / `mockMcpClient` (from `@plumbus/mcp/testing`) | Test helpers — pre-connected client + server over `InMemoryTransport` |

## How requests flow

`tools/call` → `authAdapter.authenticate(token)` → `createDependencies(authContext)` (per call) → `createExecutionContext(deps)` → `executeCapability(cap, ctx, args)`. Validation, access policy, and audit run untouched — this package does not re-implement them.

`tools/list` returns the full set of `exposeAs: ['mcp']` capabilities; access is enforced on `tools/call`.

## Auth model

Agent tokens map to service accounts. A capability's `access.serviceAccounts` list controls which agents may call it; deny-by-default still holds. Tenant-scoped capabilities require the agent's `tenantId` to match.

See [docs/mcp/agent-authentication.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/mcp/agent-authentication.md) for the full security model.

## Documentation

- [MCP overview](https://github.com/plumbus-framework/plumbus/blob/main/docs/mcp/overview.md)
- [Expose a capability](https://github.com/plumbus-framework/plumbus/blob/main/docs/mcp/expose-a-capability.md)
- [Agent authentication](https://github.com/plumbus-framework/plumbus/blob/main/docs/mcp/agent-authentication.md)
- [Transports](https://github.com/plumbus-framework/plumbus/blob/main/docs/mcp/transports.md)
- [Skill files](https://github.com/plumbus-framework/plumbus/blob/main/docs/mcp/skill-files.md)

## License

MIT
