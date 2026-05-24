# Expose a Capability to MCP

## Contract fields

On `defineCapability()`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exposeAs` | `readonly ('mcp')[]` | For MCP exposure | Include `'mcp'` to expose as an MCP tool |
| `mcp` | `McpExposureConfig` | Optional | Agent-facing metadata |

```typescript
export interface McpExposureConfig {
  description?: string;   // Overrides cap.description for agents
  dangerous?: boolean;    // Maps to destructiveHint
  agentTags?: readonly string[];
}
```

## Validation (when `exposeAs` includes `'mcp'`)

- Reject `kind: 'eventHandler'` or `kind: 'job'`.
- Require `description`, `mcp.description`, or `explanation.summary`.
- `mcp` block is validated with Zod when present.

## Tool identity

- **MCP tool name:** `cap.name` (same as capability registry and HTTP path segment after kebab-case conversion in routes).
- **HTTP path:** `/api/{domain}/{kebab-name}` — unchanged.

## Access for agents

Agents authenticate as **service accounts** (see [agent-authentication.md](./agent-authentication.md)). Example:

```typescript
access: {
  serviceAccounts: ["billing-agent"],
  scopes: ["billing:read"],
  tenantScoped: true,
},
```

Avoid `public: true` on destructive MCP tools.

## Generated manifest shape

`plumbus generate` writes `.plumbus/generated/mcp-manifest.json`:

```json
{
  "tools": [
    {
      "name": "getRefund",
      "description": "Look up a refund for billing support agents",
      "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } } },
      "agentTags": ["billing", "support"],
      "annotations": {
        "destructiveHint": false,
        "readOnlyHint": true
      }
    }
  ]
}
```

- `inputSchema` comes from `zodInputToJsonSchema(cap.input)`.
- `readOnlyHint` is `true` when `kind === 'query'`.
- `agentTags` appear in the manifest and skill files, not in the MCP SDK `ListTools` payload (unless folded into description).

## CLI

| Command | Purpose |
|---------|---------|
| `plumbus generate` | Manifest + skill files (with all other generate outputs) |
| `plumbus mcp generate` | MCP artifacts only |
| `plumbus mcp list-tools` | Print tool names and descriptions |

## Governance

An advisory governance rule warns when MCP-exposed capabilities lack an agent-facing description.
