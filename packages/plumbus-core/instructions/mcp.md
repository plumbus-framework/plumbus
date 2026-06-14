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
- **`plumbus mcp serve` / `list-tools` / `mcp generate`** — CLI entry points; `mcp.agents` in `plumbus.config.ts`.

Install the runtime when serving agents: `pnpm add @plumbus/mcp` (optional peer of `@plumbus/core`, version-locked `0.5.x`).
