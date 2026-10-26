# @plumbus/mcp changelog

## 0.8.0-beta.1 — 2026-10-25

- **Tool arguments are validated with core's `safeParseBounded`**: an array over its `.max()`, or over `PLUMBUS_INPUT_ARRAY_MAX_ITEMS` without one, is refused before zod walks it (zod GHSA-mrhx-c7xc-m3w5). **Core peer is now `>=0.9.0-beta.5 <0.10.0`.**
- **Patched dependencies:** `@modelcontextprotocol/sdk` `^1.32.2` (was `^1.29.0`; the SDK advisories below 1.32.0 and its `express` / `hono` / `proxy-addr` / `body-parser` chain), `fastify` `^5.12.7`, `drizzle-orm` `^0.45.2` (dev).

## 0.8.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.8.0-beta.0 follows 0.7.0-beta.0 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.7.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- **Breaking:** `startHttpServer({ port })` requires a port and `plumbus mcp serve --http` takes `--port` or `PLUMBUS_MCP_PORT`; no default listen port is assumed (0.7.0-beta.0). Stable 0.7.0 does not have this change.

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.7.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.7.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.7.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

### Breaking

- **`startHttpServer({ port })` is required.** `plumbus mcp serve --http` takes `--port` or `PLUMBUS_MCP_PORT`. No default listen port is assumed.

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
