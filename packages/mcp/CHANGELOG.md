# @plumbus/mcp changelog

## 0.4.0

`@plumbus/mcp` is **version-locked** to `@plumbus/core` 0.4.x via `peerDependencies` (core lists mcp as an optional peer dependency). Install it explicitly alongside `@plumbus/core` when serving capabilities to AI agents.

### Added

- **`createMcpServer`** — MCP `ListTools` / `CallTool` handlers over `executeCapability()`.
- **`startStdioServer`** — stdio transport with `PLUMBUS_MCP_TOKEN` auth resolution.
- **`startHttpServer`** — Streamable HTTP on `/mcp` plus `GET /mcp/discovery`.
- **`createMcpAuthAdapter`** — maps Bearer tokens and stdio env to `AuthContext` with `provider: 'mcp'`.
- **`registerMcpOnFastify`** — mount MCP on an existing Fastify app.
- Version-locked with `@plumbus/core` 0.4.0; installed transitively via core `dependencies`.
