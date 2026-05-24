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
- **`kind: 'job'`** and **`kind: 'eventHandler'`** cannot be MCP-exposed.
- `@plumbus/core` does not install `@plumbus/mcp`; you opt in once per app by installing the runtime (see below).

## Packages

| Package | Role | Install |
|---------|------|---------|
| `@plumbus/core` | Contract fields, `plumbus generate` manifest/skills, CLI `plumbus mcp *` | Always |
| `@plumbus/mcp` | Runtime server (stdio + Streamable HTTP), `createMcpAuthAdapter` | `pnpm add @plumbus/mcp` when you want to serve agents |

`@plumbus/mcp` is an optional peer of `@plumbus/core` (version-locked `0.4.x`). `plumbus mcp serve` prints an install hint if the package is missing.

## Workflow

1. Mark capabilities with `exposeAs: ['mcp']` and configure `access.serviceAccounts` for agents.
2. `plumbus generate` → `.plumbus/generated/mcp-manifest.json` and `skills/<domain>/<name>.md`. (No `@plumbus/mcp` needed for generation.)
3. `pnpm add @plumbus/mcp` once per app — required to start an MCP server.
4. Configure `mcp.agents` in `plumbus.config.ts` (see [agent-authentication.md](./agent-authentication.md)).
5. `plumbus mcp serve --stdio` or `plumbus mcp serve --http --port 3001`.

`tools/list` returns all MCP-exposed tools; **access is enforced on `tools/call`** (scope-filtered listing is deferred).

## Related docs

- [Expose a capability](./expose-a-capability.md)
- [Agent authentication](./agent-authentication.md)
- [Transports](./transports.md)
- [Skill files](./skill-files.md)
