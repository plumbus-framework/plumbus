# Changelog

## 0.1.0

### Added

- `cognito()` integration: allowlisted `identity_provider` hosted-login option, client-auth method selection, logout via `client_id`+`logout_uri` (no ID-token retention); cannot alter protocol validation. Peer: `@plumbus/auth 0.1.x`.
- **Agent instructions** — `instructions/` folder (configure, hosted login, logout, testing).
- **npm publish** — CI workflow publishes `@plumbus/auth-cognito` after `@plumbus/auth`.
