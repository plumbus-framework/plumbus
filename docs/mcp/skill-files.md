# MCP Skill Files

`plumbus generate` (and `plumbus mcp generate`) emit markdown skill files for each MCP-exposed capability:

```
.plumbus/generated/skills/<domain>/<kebab-name>.md
```

Example path: `skills/billing/get-refund.md` for capability `getRefund` in domain `billing`.

## Purpose

Skill files are **human- and agent-readable documentation** derived from the capability contract. They complement `mcp-manifest.json` (machine-oriented JSON Schema) for:

- Cursor / Claude project skills
- Internal agent playbooks
- PR review of what agents can invoke

## Sections

Each file includes:

| Section | Source |
|---------|--------|
| Name | `cap.name` |
| Description | `mcp.description` ?? `description` ?? `explanation.summary` |
| Input Schema | JSON Schema from Zod input |
| Agent Tags | `mcp.agentTags` |
| Required Scopes / Roles | `access.scopes`, `access.roles` |
| Tenant Scoped | `access.tenantScoped` |
| Dangerous | `mcp.dangerous` |
| Effects | `effects.data`, `effects.events`, `effects.external`, AI flag |

## Consumption

1. **Codegen:** regenerate after contract changes (`plumbus generate`).
2. **Agents:** copy or symlink `skills/` into your agent's skill directory, or reference paths in MCP client config.
3. **CI:** diff skill files in PRs when `exposeAs: ['mcp']` capabilities change.

Skills are additive generate output; existing `openapi.json` and `manifest.json` paths are unchanged.

## API

Framework authors can render a single file with:

```typescript
import { renderSkillFile } from '@plumbus/core/mcp';
```

This is used by the CLI; apps normally rely on generate output rather than calling it at runtime.
