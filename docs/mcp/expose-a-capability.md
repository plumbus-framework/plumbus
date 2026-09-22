# Expose a Capability to MCP

## Contract fields

On `defineCapability()`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exposeAs` | `readonly ('mcp' \| 'api')[]` | For MCP | Include `'mcp'` to expose as an MCP tool (`'api'` is the partner HTTP surface — see `@plumbus/api` docs) |
| `mcp` | `McpExposureConfig` | Optional | Agent-facing metadata |

```typescript
export interface McpExposureConfig {
  description?: string;   // Overrides cap.description for agents
  dangerous?: boolean;    // Maps to destructiveHint
  agentTags?: readonly string[];
}
```

## Validation (when `exposeAs` includes `'mcp'`)

- Reject `kind: 'eventHandler'`. `kind: 'job'` is supported via MCP Tasks — see [tasks-and-jobs.md](./tasks-and-jobs.md).
- Require `description`, `mcp.description`, or `explanation.summary`.
- `mcp` block is validated with Zod when present.

## Tool identity

- **MCP tool name:** canonical `<domain>.<capabilityName>` (e.g. `billing.getRefund`) — same as the capability registry key and `plumbus generate` manifest `tools[].name`.
- **HTTP path:** `/api/{domain}/{kebab-name}` — unchanged; routes still use kebab-case of the local `name` field.

After upgrading, run `plumbus generate` and update agent configs that referenced short local names. See [Upgrading capability names](../upgrading-capability-names.md).

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
      "name": "billing.getRefund",
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

## Exposing a `kind: 'job'` capability

Long-running operations (report generation, batch processing, slow external calls) are exposed as MCP tasks. The same `defineCapability({ kind: 'job', exposeAs: ['mcp'] })` works — the runtime returns a task instead of an inline result when the client opts in with `taskMetadata`.

Required wiring: register `mcpTaskEntity` in the app's entity list. See [tasks-and-jobs.md](./tasks-and-jobs.md) for the full sequence diagram, `ctx.progress.report` usage, and cancellation semantics.
