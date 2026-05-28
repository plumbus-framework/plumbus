# @plumbus/mcp — Agent Instructions

This folder ships with the npm tarball. It is the entry point for AI coding agents working in a Plumbus app that has `@plumbus/mcp` installed. Read these files when exposing capabilities to external agents, wiring tasks for long-running jobs, or writing MCP tests.

These files are **prescriptive** (do this, don't do that). For deeper conceptual reference (spec coverage matrix, sequence diagrams, full transport options), see `docs/mcp/` in the Plumbus monorepo.

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Package map, what core owns vs what `@plumbus/mcp` owns, critical rules. |
| [expose-a-capability.md](./expose-a-capability.md) | Marking capabilities with `exposeAs: ['mcp']` (queries and actions). |
| [tasks.md](./tasks.md) | `kind: 'job'` over MCP Tasks — `mcpTaskEntity` wiring, `ctx.progress`, cancellation. |
| [testing.md](./testing.md) | `@plumbus/mcp/testing` — `createTestMcpServer`, `mockMcpClient`. |

Package quickstart: [../README.md](../README.md).

## Critical rules

- **Token mapping is direct.** A map key in `mcp.agents` **is** the bearer token verbatim. No "secret" field. Pick high-entropy strings.
- **`kind: 'job'` IS supported via MCP Tasks.** Older instructions may say otherwise — current truth: only `eventHandler` is rejected from MCP. Jobs run through `tools/call` with `_meta.taskMetadata`.
- **Apps that expose `kind: 'job'` via MCP MUST register `mcpTaskEntity`** in their entity list. Without it, the runtime throws `McpTask entity not registered — add mcpTaskEntity to the app entity list`.
- **Never put `access.public: true` on a destructive MCP-exposed capability.** `plumbus doctor` fails on this combo.
- **The metrics hook fires on both paths.** `McpServerConfig.onMcpToolCall` covers inline `tools/call` and the background task path. Errors are caught and logged to stderr.
