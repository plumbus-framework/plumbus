# MCP (Model Context Protocol)

Plumbus capabilities can be exposed to **external AI agents** (Claude Desktop, Cursor, custom agent runners, headless automation) as MCP tools — using the same validation, access policies, and audit pipeline as HTTP routes.

## When to use MCP

| Surface | Best for |
|---------|----------|
| HTTP (`plumbus start`) | Humans, web apps, mobile, REST integrations |
| MCP (`plumbus mcp serve`) | AI agents calling your app's logic |

MCP is **opt-in per capability**. The default remains HTTP-only.

## Opt-in: `exposeAs: ['mcp']`

```ts
import { defineCapability } from "@plumbus/core";
import { z } from "zod";

export const getRefund = defineCapability({
  name: "getRefund",
  kind: "query",
  domain: "billing",
  description: "Fetch a refund by id",

  // Opt-in to MCP exposure
  exposeAs: ["mcp"],
  mcp: {
    description: "Look up a refund for billing support agents",
    dangerous: false,            // require explicit agent confirmation
    agentTags: ["billing", "support"],
  },

  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), amount: z.number() }),

  access: {
    serviceAccounts: ["billing-agent"],   // which agents may call this
    tenantScoped: true,
  },

  effects: { data: ["Refund"], events: [], external: [], ai: false },

  handler: async (ctx, { id }) => ctx.data.Refund.byId(id),
});
```

### MCP exposure rules

- Only `kind: "query"` and `kind: "action"` may be MCP-exposed. `job` and `eventHandler` are rejected at `defineCapability()` time.
- Either `description`, `mcp.description`, or `explanation.summary` is required when MCP-exposed (agents need to know what the tool does).
- A capability without `exposeAs: ['mcp']` is never exposed to agents — behavior is unchanged.

## Agent authentication

Configure agent tokens in `plumbus.config.ts`:

```ts
export default {
  mcp: {
    agents: {
      "opaque-token-from-agent-runtime": {
        serviceAccountId: "billing-agent",
        scopes: ["billing:read"],
        tenantId: "tenant-1",
      },
    },
  },
};
```

- Token mapping: opaque Bearer / `PLUMBUS_MCP_TOKEN` env value → `AuthContext` with `provider: "mcp"`, `userId: serviceAccountId`, `scopes`, optional `tenantId`.
- Capability `access.serviceAccounts` controls which agents may call which tools. Deny-by-default still holds.
- Tenant-scoped capabilities require the agent's `tenantId` to match the request context. Cross-tenant calls are denied through the existing access pipeline.

## Running an MCP server

```bash
# Generate the MCP tool manifest + skill files (no runtime install needed)
plumbus generate
# → .plumbus/generated/mcp-manifest.json
# → .plumbus/generated/skills/<domain>/<kebab-name>.md

# Install the runtime (one-time, per app)
pnpm add @plumbus/mcp

# Serve over stdio (Claude Desktop, Cursor, local agents)
plumbus mcp serve --stdio

# Serve over Streamable HTTP (remote agents)
plumbus mcp serve --http --port 3001
# → POST /mcp                 — Streamable HTTP transport
# → GET  /mcp/discovery       — manifest + auth scheme

# Debug: list MCP-exposed tools as a flat table
plumbus mcp list-tools
```

## Package layout

| Package | Provides |
|---------|----------|
| `@plumbus/core` | `exposeAs` field, `plumbus generate` MCP outputs, CLI `plumbus mcp *` |
| `@plumbus/mcp` | Runtime server (stdio + Streamable HTTP), `createMcpAuthAdapter`, discovery route |

`@plumbus/mcp` is an **optional peer dependency** of `@plumbus/core` (version-locked `0.4.x`). Apps that don't expose MCP tools never install it. `plumbus mcp serve` prints `Run: pnpm add @plumbus/mcp` if the runtime is missing.

## Request flow

```
tools/call
  → authAdapter.authenticate(token)         // McpAuthAdapter from agents map
  → createDependencies(authContext)          // per-call; same as HTTP route handler
  → createExecutionContext(deps)             // includes ctx.signal from MCP cancel
  → executeCapability(cap, ctx, args)        // same dispatch as HTTP — full pipeline
  → CapabilityResult mapped to MCP content / isError
```

The MCP server is a **thin adapter**. It does not re-implement validation, access policy, or audit — those run inside `executeCapability()` exactly as they do for HTTP.

`tools/list` returns all `exposeAs: ['mcp']` capabilities. Access is enforced on `tools/call`, not on listing.

## Common patterns

### Read-only agent tool

```ts
exposeAs: ["mcp"],
mcp: { description: "Look up an order by id" },
kind: "query",
access: { serviceAccounts: ["order-agent"], tenantScoped: true },
```

### Write tool requiring agent confirmation

```ts
exposeAs: ["mcp"],
mcp: { description: "Refund an order", dangerous: true },
kind: "action",
access: { serviceAccounts: ["billing-agent"], scopes: ["billing:write"], tenantScoped: true },
```

`dangerous: true` maps to MCP `annotations.destructiveHint`, which clients use to require explicit human confirmation before calling.

### Don't expose

- Capabilities with `access.public: true` should almost never be MCP-exposed for destructive actions.
- `kind: "job"` and `kind: "eventHandler"` cannot be MCP-exposed (the framework rejects this at definition time).
- Capabilities with side effects you don't want an agent triggering without auditing.

## What an agent sees

- **`tools/list`** — every capability with `exposeAs: ['mcp']`. Each tool gets `name`, `description` (with `mcp.description` overriding the general `description`), `inputSchema` (JSON Schema from the Zod input), and `annotations` (`destructiveHint`, `readOnlyHint`).
- **`tools/call`** — full Plumbus pipeline runs: Zod input validation → access policy → handler → Zod output validation → audit.
- **Errors** map to `{ isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] }` with the `PlumbusError` code preserved.

## Generated skill files

`plumbus generate` writes `.plumbus/generated/skills/<domain>/<kebab-name>.md` for each MCP-exposed capability. These are human-readable summaries (name, description, input schema, scopes/roles required, tenant scoping, dangerous flag, effects) that agents and humans can read to understand a tool without parsing JSON.

Skill files are derived purely from the capability contract — do not edit them by hand. Regenerate with `plumbus generate`.
