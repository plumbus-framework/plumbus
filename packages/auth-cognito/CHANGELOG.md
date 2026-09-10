# Changelog

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.0

### Added

- `cognito()` integration: allowlisted `identity_provider` hosted-login option, client-auth method selection, logout via `client_id`+`logout_uri` (no ID-token retention); cannot alter protocol validation. Peer: `@plumbus/auth 0.1.x`.
- **Agent instructions** — `instructions/` folder (configure, hosted login, logout, testing).
- **npm publish** — CI workflow publishes `@plumbus/auth-cognito` after `@plumbus/auth`.
