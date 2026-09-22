# Recipe: Expose a capability over MCP

When the user asks to expose a capability to AI agents (Claude Desktop, Cursor, custom agent runtimes), follow this recipe.

## 1. Mark the capability

Add `exposeAs: ['mcp']` and provide an agent-facing description:

```ts
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

export const getRefund = defineCapability({
  name: "getRefund",
  kind: "query",                                     // query | action | job
  domain: "billing",
  description: "Fetch a refund by id",

  exposeAs: ["mcp"],
  mcp: {
    description: "Look up a refund for billing support agents",
    dangerous: false,                                // maps to MCP destructiveHint
    agentTags: ["billing", "support"],               // appear in manifest + skill files
  },

  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), amount: z.number() }),

  access: {
    serviceAccounts: ["billing-agent"],              // which agents may call this
    tenantScoped: true,
  },

  effects: { data: ["Refund"], events: [], external: [], ai: false },

  handler: async (ctx, { id }) => ctx.data.Refund.byId(id),
});
```

## 2. Configure agent tokens

Configure an agent map in application-owned MCP bootstrap and pass its adapter to `createMcpServer` / the transport configuration:

```ts
import { createErrorService } from "@plumbus/core";
import { createMcpAuthAdapter } from "@plumbus/mcp";

const token = process.env["MCP_AGENT_TOKEN"];
if (!token) throw createErrorService().validation("MCP_AGENT_TOKEN is required");

export const authAdapter = createMcpAuthAdapter({
  agents: {
    [token]: {
      serviceAccountId: "billing-agent",
      scopes: ["billing:read"],
      tenantId: "tenant-1",
    },
  },
  envToken: process.env["PLUMBUS_MCP_TOKEN"],
});
```

- The map key is the bearer token. Load a high-entropy value from secret configuration; never commit real tokens.
- Successful authentication yields `provider: "mcp"`, `userId: serviceAccountId`, scopes, and the configured tenant.
- The current CLI does **not** import `plumbus.config.*`. Use an app-owned runner for this opaque-token map, or configure `AUTH_SECRET` for CLI Bearer JWT authentication. CLI stdio JWT callers must forward Authorization metadata; map-based stdio runners can use `PLUMBUS_MCP_TOKEN`.
- An explicit invalid Authorization header never falls back to the environment token. HTTP transport calls always require explicit credentials. Capability access policies still govern every call.

## 3. Generate manifest + skill files

```bash
plumbus generate
# → .plumbus/generated/mcp-manifest.json
# → .plumbus/generated/skills/<domain>/<kebab-name>.md
```

`plumbus generate` works **without** `@plumbus/mcp` installed — only `plumbus mcp serve` needs the runtime.

## 4. Run an MCP server

```bash
plumbus mcp serve --stdio                # JWT Authorization metadata, or anonymous development
plumbus mcp serve --http --port 3001     # remote agents over Streamable HTTP
plumbus mcp list-tools                   # debug: print tool names + descriptions
```

If `@plumbus/mcp` is not installed, `plumbus mcp serve` prints `Run: pnpm add @plumbus/mcp` and exits.

## Rules

- **Only `kind: 'query'`, `kind: 'action'`, and `kind: 'job'` may be MCP-exposed.** `eventHandler` is rejected at `defineCapability()` time (no caller surface). `kind: 'job'` runs through MCP Tasks — see [tasks.md](./tasks.md).
- **Either `description`, `mcp.description`, or `explanation.summary` is required** when MCP-exposed (agents need to know what the tool does).
- **A capability without `exposeAs: ['mcp']` is never exposed to agents.** Tag-based discovery is not supported.
- **Never combine `access.public: true` with `exposeAs: ['mcp']`.** `plumbus doctor` fails on any MCP-exposed capability with `access.public: true`, regardless of kind.
- **Tenant-scoped capabilities** require the agent's configured `tenantId` to match the request context. Cross-tenant calls are denied at the access pipeline.

## Startup authentication

Without an agent map, an explicit valid `AUTH_SECRET` selects JWT authentication. Development without credentials is anonymous and never verifies a placeholder-signed token; outside development missing credentials stop startup. HTTP transport authentication is mandatory even for initialization/listing. Public discovery remains separately configurable. Do not restore the old development signing key or unauthenticated transport route as a workaround.

## Tool names (canonical)

MCP tool names use the **canonical** `<domain>.<capabilityName>` form (e.g. `billing.getRefund`), matching the capability registry and `plumbus generate` manifest — not the short local `name` field alone. After upgrading, run `plumbus generate` and update agent configs that referenced short names.

## What an agent sees

- **`tools/list`** — every capability with `exposeAs: ['mcp']`. Each tool: `name` (canonical), `description` (`mcp.description` overrides `description`), `inputSchema` (JSON Schema from Zod input), `annotations` (`destructiveHint`, `readOnlyHint`).
- **`tools/call`** — full Plumbus pipeline runs: Zod input validation → access policy → handler → Zod output validation → audit.
- **Errors** map to `{ isError: true, content: [{ type: 'text', text: JSON.stringify(safeError) }] }` preserving the error code while filtering metadata and using generic internal/denial messages. Detailed diagnostics belong in server-side hooks.

## Observability

Wire metrics with `McpServerConfig.onMcpToolCall`:

```ts
const config: McpServerConfig = {
  // ... existing fields
  onMcpToolCall: (info) => {
    metrics.histogram("mcp_tool_call_ms", info.durationMs, {
      capability: info.capabilityName,
      domain: info.domain,
      status: info.status,                          // 'success' | 'error'
    });
  },
};
```

Fires on both paths (sync `tools/call` and the background task path for jobs). Errors thrown by the hook are caught and logged to stderr — they never propagate to the MCP client.
