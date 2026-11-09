# @plumbus/mcp changelog

## 0.7.1 — 2026-11-09

- **Security release.** See [the 0.8.5 security upgrade notes](../../docs/upgrading-0.8.5-security.md) for every opt-in and warning.
- `@modelcontextprotocol/sdk` ^1.32.2 (memory exhaustion, unbounded bodies/batches, task/session advisories, and the vulnerable `proxy-addr`/`hono`/`express` transitive tree), `fastify` ^5.12.8.
- **Fix, stateless Streamable HTTP:** each request is now served by a fresh MCP server and transport. SDK 1.32 refuses to reuse a stateless transport, so the second request on the old shared one failed.
- **Stateful Streamable HTTP (`stateless: false`):** one server and transport per session, bound to the user and tenant that sent `initialize`. A request for that session from any other user or tenant gets `404 Session not found`, and can't read its SSE stream, send on it or DELETE it. Sessions are cleaned up on DELETE, close and `app.close()`. New opt-in `sessionIdleTimeoutMs` closes idle sessions.
- **Tasks:** a task created in a stateful HTTP session is visible to `tasks/get`, `tasks/result`, `tasks/cancel` and `tasks/list` only from that session while it is open. The binding is kept in memory, so there is no `McpTask` schema change or migration. Tasks without a session keep the user + tenant check.
- **Limits (GHSA-46jr-4wx8-v453):** new `McpServerConfig.maxToolInputElements` (default 100 000; `Infinity` disables) refuses oversized `tools/call` arguments with `InvalidParams` before validation. New `maxRequestBodySize` on `registerMcpOnFastify` / `startHttpServer` sets the MCP route body limit and the SDK transport limit; the Fastify body limit still applies.

## 0.7.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.6.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.6.0.

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
