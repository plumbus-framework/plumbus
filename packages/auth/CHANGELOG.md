# Changelog

## 0.1.0

### Added

- OIDC RP runtime: `createAuthRuntime`, discovery, Code+PKCE(S256), opaque `__Host-plumbus_session` sessions (capped multi-session, default 5/user), CSRF via `GET /auth/session` + `X-CSRF-Token`, the six `/auth` routes, resolver hooks, memory+PostgreSQL protected stores, provider-integration contract. Peer: `@plumbus/core 0.6.x`.
- **`docs/auth/`** — human documentation and agent instructions (`instructions/`).
- **npm publish** — CI workflow publishes `@plumbus/auth` after `@plumbus/core`.
