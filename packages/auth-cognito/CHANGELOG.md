# Changelog

## 0.2.2 — 2026-09-27

### Added

- **Server-attested sign-in** (`@plumbus/auth-cognito/server`) for apps that keep their own passwordless sign-in (magic links, passkeys) and use Cognito as the user directory and token issuer:
  - `createCognitoPoolUsers()` — `ensureUser` (admin-created, no Cognito message, email verified, confirmed); `signIn`, which runs custom auth answered with an HMAC attestation, verifies the ID token against the pool's JWKS and revokes the refresh token; `setUserEnabled` and `updateEmail`.
  - `createCognitoPoolAdministration()` — idempotent `ensureAttestedUserPool` (admin-only sign-up, `admin_only` recovery, triggers, deletion protection, ownership tags, secretless custom-auth client), `deleteUserPool` (ownership-checked; restates security settings while turning off deletion protection), and `readMfaPolicy`.
  - `createCognitoPoolDirectory()` — administer a hosted-login pool's users without signing anyone in: `inviteUser` (Cognito emails a temporary password, or `sendInvitation: false` for none yet), `resendInvitation`, `getUser`, `listUsers`, `setUserEnabled`, `deleteUser`, `updateEmail`. `createCognitoPoolUsers` is built on it.
  - `createCognitoIdTokenVerifier()` and `cognitoUserPoolIssuer()`.
  - `CognitoServerError` with stable reasons (`user-disabled`, `challenge-refused`, `provider-unavailable`, …).
- **`@plumbus/auth-cognito/triggers`**: `createAttestedSignInTrigger()`, one dependency-free Lambda handler for the Define/Create/Verify custom-auth triggers. The attestation binds pool id, username and nonce; keyrings rotate by key id.
- **`@plumbus/auth-cognito/testing`**: `startFakeCognito()`, an in-process Cognito for the AWS SDK (endpoint override). It runs the real trigger and serves per-pool JWKS, OIDC discovery and a minimal hosted login for `@plumbus/auth`, with fault injection; `deliveries(poolId)` lists the invitation emails it would have sent, and a first hosted sign-in confirms a user still on a temporary password. `port`/`host` options pin the endpoint when issuers must stay stable across restarts.

### Dependencies

- Adds `@aws-sdk/client-cognito-identity-provider` and `jose`. They are imported only by the `./server` and `./testing` subpaths; the root `cognito()` export and `./triggers` do not load them. Peer dependencies are unchanged (`@plumbus/auth` `0.2.x`).

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.0

### Added

- `cognito()` integration: allowlisted `identity_provider` hosted-login option, client-auth method selection, logout via `client_id`+`logout_uri` (no ID-token retention); cannot alter protocol validation. Peer: `@plumbus/auth 0.1.x`.
- **Agent instructions** — `instructions/` folder (configure, hosted login, logout, testing).
- **npm publish** — CI workflow publishes `@plumbus/auth-cognito` after `@plumbus/auth`.
