# @plumbus/mcp changelog

## 0.5.0

Version-locked with `@plumbus/core` **0.5.x** via `peerDependencies`.

### Added

- **`jobQueue` on `McpServerConfig`** — when Redis is durable, `kind: 'job'` task dispatch enqueues to the shared jobs queue instead of running in-process only.
- **`createMcpJobCompletionSync`** — worker-side hook to complete MCP task rows when jobs dequeue on a separate worker process.

### Changed

- **`plumbus mcp serve`** — wires `jobQueue` automatically when `resolveRuntimeQueues` returns `isDurable: true`; without Redis, MCP jobs stay in-process (unchanged from 0.4.x).

### Upgrading

Split deployments (API/MCP + `plumbus worker`) need Redis and `@plumbus/mcp` on the worker when exposing MCP `kind: 'job'` tools. See `docs/mcp/tasks-and-jobs.md` and `docs/upgrading-workers.md`.

## 0.4.1

### Documentation

- README ecosystem table lists `@plumbus/api` (partner external API add-on).

## 0.4.0

`@plumbus/mcp` is **version-locked** to `@plumbus/core` 0.4.x via `peerDependencies` (core lists mcp as an optional peer dependency). Install it explicitly alongside `@plumbus/core` when serving capabilities to AI agents.

### Added

- **`createMcpServer`** — MCP `ListTools` / `CallTool` handlers over `executeCapability()`.
- **`startStdioServer`** — stdio transport with `PLUMBUS_MCP_TOKEN` auth resolution.
- **`startHttpServer`** — Streamable HTTP on `/mcp` plus `GET /mcp/discovery`.
- **`createMcpAuthAdapter`** — maps Bearer tokens and stdio env to `AuthContext` with `provider: 'mcp'`.
- **`registerMcpOnFastify`** — mount MCP on an existing Fastify app.
- Version-locked with `@plumbus/core` 0.4.0; installed transitively via core `dependencies`.
