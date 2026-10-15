# Changelog

## 0.4.0-beta.2 — 2026-10-16

- **Peer floor raised to core 0.9.0-beta.1.** The `@plumbus/core` peer is now `>=0.9.0-beta.1 <0.10.0` (was `>=0.9.0-beta.0 <0.10.0`). 0.4.0-beta.1 imports `executeIdempotently`, which core 0.9.0-beta.0 does not export, so npm accepted a pair that failed at load time. npm now refuses it. No code change.

## 0.4.0-beta.1 — 2026-10-15

- **Shared idempotency store.** `registerApiRoutes` uses `opts.idempotencyStore`, else the core server's store (`routeConfig.idempotencyStore` — `createServer({ idempotencyStore })` or `export const idempotencyStore` in `app/server.ts`), else an in-memory store, which now warns when `PLUMBUS_ENV` / `NODE_ENV` is `production` or `staging`. With core's `createDatabaseIdempotencyStore`, partner keys live in the control plane's `request_idempotency` and the completion commits inside the capability's transaction.
- **Behaviour change:** the same key with a different payload is answered `422 idempotency_conflict` (was `409`); a key held by another in-flight request (database store) is `409 idempotency_in_progress` with `Retry-After`.
- Requires `@plumbus/core` 0.9.0-beta.1 (it uses `executeIdempotently`); the peer range stays the family literal, so install the family together.

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.0 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- OpenAPI 3.1 conversion (`toJsonSchema2020`, `toOpenApi31Document`) lives in `@plumbus/core` and is re-exported here with the partner `OpenApiDocument` type; the partner generator still defaults to 3.0.3 (0.3.0-beta.0).

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

### Changed

- **OpenAPI 3.1 conversion lives in `@plumbus/core`.** `toJsonSchema2020` / `toOpenApi31Document` are implemented there so `plumbus generate` and `plumbus api generate openapi --openapi-version 3.1.0` share one rewrite. This package re-exports them with the partner `OpenApiDocument` type. Behaviour of the partner generator is unchanged (3.0.3 default).

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- This release is an explicit minor-line upgrade. Previous caret ranges exclude it; install the coordinated core 0.7.x family and follow the [migration checklist](../../docs/upgrading-security-release.md). Packages publish to npm’s default `latest` dist-tag.

### Agent instructions

- Updated packaged guidance for the security release and linked the core upgrade checklist. Refresh generated app instructions with `plumbus init --patch` (wiring v16).

### Security

- Return generic permission-denied responses instead of exposing required roles/scopes, and sanitize internal errors with 5xx metadata statuses.
- Flag query-string API-key schemes in manifest validation and reject them during OpenAPI export because the runtime does not read them.

### Compatibility

- Runtime route and payload interfaces are unchanged. Manifests advertising query API keys must use implemented authentication before export. Deploy with core 0.7.0 for the complete security release. [Migration guide](../../docs/upgrading-security-release.md).

## 0.1.4 — 2026-08-10 — partner routes honor session auth

**Runtime floor: `@plumbus/core` ≥ 0.6.9.** This release imports `buildAuthenticationRequest` from `@plumbus/core`, which first shipped in core **0.6.9**. On older cores the package fails to load. Declared peer stays `0.5.x || 0.6.x`; the floor applies at runtime.

### Fixed

- **`registerApiRoutes` honors `requestAuthenticator`** — partner `/api/v1/*` routes now use the same cookie-session / composite authenticator path as convention routes when `createServer({ authenticationRuntime })` (or an explicit `RouteGeneratorConfig.requestAuthenticator`) is configured. Browser clients no longer need a partner JWT solely to call API-exposed capabilities; Bearer `authAdapter` remains for machine callers. Session principals map into `ctx.auth` (including `tenantId` when present). New partner error codes: `csrf_failed` (403), `authentication_unavailable` (503).
- **Per-request anonymous auth context** — anonymous partner requests no longer share one `AuthContext` object (and its `roles`/`scopes` arrays) across requests.

### Docs

- Document browser cookie session vs machine JWT on the partner surface (`docs/api/exposure-model.md`, overview lifecycle, README request flow).
- Generated per-operation docs list `csrf_failed`, `missing_scope`, and `authentication_unavailable` in the Errors table.

## 0.1.3

### Added

- **`securitySchemes` manifest field** — discriminated union for `http`, `apiKey` (cookie + optional `x-plumbus-csrf`), `oauth2`, and `openIdConnect` schemes.
- **`identity.defaultSecurityScheme`** and per-exposure `auth.scheme` for explicit OpenAPI security requirements.
- **`validateSecurityConfig`** — validates scheme references, legacy `defaultAuth` diagnostics, and rejects invented `/oauth/token` URLs.
- **Auth session documentation** — [docs/api/manifest.md](../../docs/api/manifest.md) and [docs/api/openapi.md](../../docs/api/openapi.md) clarify partner OAuth schemes vs first-party `@plumbus/auth` cookie sessions.
- **Ecosystem table** — README lists `@plumbus/auth` and `@plumbus/auth-cognito`.

### Changed

- OpenAPI generation no longer infers OAuth2 from capability scopes alone or emits `/oauth/token`.
- Security schemes are taken only from explicit manifest `securitySchemes` definitions.
- `validateApiContract` includes a `security` findings bucket.

## 0.1.2

### Changed

- Peer dependency `@plumbus/core` widened to `0.5.x || 0.6.x` for `@plumbus/core` **0.6.x** compatibility.

## 0.1.1

### Changed

- Peer dependency `@plumbus/core` updated to `0.5.x` (version-locked with core **0.5.0** workers/queues and canonical capability names release).

## 0.1.0

- Initial release: API exposure model (`exposeAs: ['api']`), manifest parsing, OpenAPI/docs generation, test intent (`validate-only`, `safe-reply`), policy validation, compatibility diff, `registerApiRoutes`.
