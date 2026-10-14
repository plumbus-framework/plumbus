# Changelog

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.2 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/auth` `>=0.4.0-beta.0 <0.5.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- Server-attested sign-in (`./server`, `./triggers`, `./testing`; also in stable 0.2.2) from 0.3.0-beta.1, and the refreshed README and attested-sign-in guidance, including the warning to provision each named user pool from one step (0.3.0-beta.2).

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Pairs with `@plumbus/auth` 0.4.0-beta.0, which carries the auth 0.3.1 audit-write and expiry-sweep fixes.
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/auth` `0.3.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.2 — 2026-10-12

- Refresh the README and packaged attested-sign-in guidance, including the public API warning to provision each named user pool from one step rather than concurrently across replicas. Runtime behavior is unchanged.

## 0.3.0-beta.1 — 2026-09-27 — core 0.8 beta family

### Added

- **Server-attested sign-in** (`@plumbus/auth-cognito/server`) for apps that keep their own passwordless sign-in (magic links, passkeys) and use Cognito as the user directory and token issuer:
  - `createCognitoPoolUsers()` — `ensureUser` (admin-created, no Cognito message, email verified, confirmed); `signIn`, which runs custom auth answered with an HMAC attestation, verifies the ID token against the pool's JWKS and revokes the refresh token; `setUserEnabled` and `updateEmail`.
  - `createCognitoPoolAdministration()` — idempotent `ensureAttestedUserPool` (admin-only sign-up, `admin_only` recovery, triggers, deletion protection, ownership tags, secretless custom-auth client), `deleteUserPool` (ownership-checked; restates security settings while turning off deletion protection), and `readMfaPolicy`.
  - `createCognitoPoolDirectory()` — administer a hosted-login pool's users without signing anyone in: `inviteUser` (Cognito emails a temporary password, or `sendInvitation: false` for none yet), `resendInvitation`, `getUser`, `listUsers`, `setUserEnabled`, `deleteUser`, `updateEmail`. `createCognitoPoolUsers` is built on it.
  - `createCognitoIdTokenVerifier()` and `cognitoUserPoolIssuer()`.
  - `CognitoServerError` with stable reasons (`user-disabled`, `challenge-refused`, `provider-unavailable`, …).
- **`@plumbus/auth-cognito/triggers`**: `createAttestedSignInTrigger()`, one dependency-free Lambda handler for the Define/Create/Verify custom-auth triggers. The attestation binds pool id, username and nonce; keyrings rotate by key id.
- **`@plumbus/auth-cognito/testing`**: `startFakeCognito()`, an in-process Cognito for the AWS SDK (endpoint override). It runs the real trigger and serves per-pool JWKS, OIDC discovery and a minimal hosted login for `@plumbus/auth`, with fault injection; `deliveries(poolId)` lists the invitation emails it would have sent, and a first hosted sign-in confirms a user still on a temporary password. `port`/`host` options pin the endpoint when issuers must stay stable across restarts.
- **`instructions/attested-sign-in.md`** for coding agents. `plumbus init --patch` links it from core 0.7.7 (agent wiring v18).

### Dependencies

- Adds `@aws-sdk/client-cognito-identity-provider` and `jose`. They are imported only by the `./server` and `./testing` subpaths; the root `cognito()` export and `./triggers` do not load them.

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

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
- **`instructions/attested-sign-in.md`** for coding agents. `plumbus init --patch` links it from core 0.7.7 (agent wiring v18).

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
