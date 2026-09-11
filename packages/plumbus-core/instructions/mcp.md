# MCP (Model Context Protocol) — Core surface

Plumbus capabilities can be exposed to external AI agents as MCP tools. **Contract and CLI** live in `@plumbus/core`; **runtime server, tasks, and test helpers** live in `@plumbus/mcp`.

## Where to read

| Layer | Location |
|-------|----------|
| **Agent recipes (start here when `@plumbus/mcp` is installed)** | `node_modules/@plumbus/mcp/instructions/README.md` |
| **Conceptual docs** | `docs/mcp/` in the monorepo — [overview](../../../docs/mcp/overview.md), [expose-a-capability](../../../docs/mcp/expose-a-capability.md), [agent-authentication](../../../docs/mcp/agent-authentication.md), [tasks-and-jobs](../../../docs/mcp/tasks-and-jobs.md), [transports](../../../docs/mcp/transports.md) |

## Core responsibilities

- **`exposeAs: ['mcp']`** on `defineCapability` — opt-in per capability.
- **`kind: 'query'` and `kind: 'action'`** — standard MCP tools via `tools/call`.
- **`kind: 'job'`** — exposed via MCP Tasks (`tools/call` + `_meta.taskMetadata`); see Tasks section in `@plumbus/mcp/instructions/README.md` and [tasks-and-jobs.md](../../../docs/mcp/tasks-and-jobs.md). **`kind: 'eventHandler'`** cannot be MCP-exposed.
- **`plumbus generate`** — MCP manifest + skill files (no `@plumbus/mcp` install required).
- **`plumbus mcp serve` / `list-tools` / `mcp generate`** — CLI entry points. The current CLI loads environment config, not `plumbus.config.*`; use `AUTH_SECRET` for CLI JWT authentication, or application-owned runtime wiring for `mcp.agents`.

Install the runtime when serving agents: `pnpm add @plumbus/mcp` (optional peer of `@plumbus/core`, version-locked `0.7.x`).


Core 0.7.0 + MCP 0.6.0 require explicit authentication on every HTTP transport request. Discovery remains separately configurable. Environment-token fallback is for map-based stdio calls without an explicit header; an invalid header never falls back. Read [the security release checklist](./upgrading-security-release.md).
