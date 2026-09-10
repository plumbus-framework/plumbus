# @plumbus/mcp changelog

## 0.6.0 — 2026-09-10

### Upgrade boundary

- This release is an explicit minor-line upgrade. Previous caret ranges exclude it; install the coordinated core 0.7.x family and follow the [migration checklist](../../docs/upgrading-security-release.md). Packages publish to npm’s default `latest` dist-tag.

### Agent instructions

- Updated packaged guidance for the security release and linked the core upgrade checklist. Refresh generated app instructions with `plumbus init --patch` (wiring v16).

### Security

- Require explicit HTTP transport credentials before SDK dispatch; invalid headers never fall back to a server environment token. The separate discovery route retains its configured public default.
- Sanitize capability/task errors, validate task arguments/access before storage or dispatch, and enforce task owner/tenant boundaries, including tenantless jobs.
- Recreate repository bindings per worker completion. `createMcpJobCompletionSync` retains its original dependency-object form and adds a dependency-factory form.

### Compatibility

- HTTP clients must now authenticate initialization/listing as well as calls. Tool names and task payloads are unchanged; error details are intentionally reduced.
- Deploy core 0.7.0 for the coordinated security fixes. Plumbus peers now require the new release family; do not mix these packages with legacy core. [Migration guide](../../docs/upgrading-security-release.md).

## 0.5.1

### Changed

- Peer dependency `@plumbus/core` widened to `0.5.x || 0.6.x` for `@plumbus/core` **0.6.x** compatibility.

## 0.5.0

Version-locked with `@plumbus/core` **0.5.x** via `peerDependencies`.

### Added

- **`jobQueue` on `McpServerConfig`** — when Redis is durable, `kind: 'job'` task dispatch enqueues to the shared jobs queue instead of running in-process only.
- **`createMcpJobCompletionSync`** — worker-side hook to complete MCP task rows when jobs dequeue on a separate worker process.

### Breaking

- **Canonical MCP tool names** — `tools/list` and `tools/call` use `<domain>.<capabilityName>` (e.g. `billing.getRefund`), matching the capability registry and generated manifest. Agents and integrations that called tools by short local `name` must update to canonical names after `plumbus generate`.

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
