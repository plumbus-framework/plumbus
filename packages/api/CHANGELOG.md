# Changelog

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
