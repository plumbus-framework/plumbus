# Changelog

## 0.1.2 — 2026-08-10 — fake OIDC per-request subjects

### Fixed

- **`authenticator` is now stable across `initialize()`.** `createAuthRuntime` previously returned a getter that resolved to the live session authenticator only after `initialize()`, but `createServer({ authenticationRuntime })` captures `routeConfig.requestAuthenticator` synchronously at bootstrap — before the auth plugin calls `initialize()`. Apps following the documented wiring therefore got the pre-init anonymous stub, and cookie sessions never authenticated partner (or convention) routes. The runtime now exposes a single delegating authenticator that resolves the live session authenticator at request time, so a `authenticator` reference captured before `initialize()` authenticates sessions correctly once initialized. Regression-tested in `src/__tests__/integration.test.ts`.

### Added

- **Fake OIDC `fake_sub`** — `startFakeOidcProvider` accepts a per-request subject via `fake_sub` on `GET`/`POST /authorize` (query or form body), falling back to startup `subOverride` / `test-subject`. Access tokens are bound to that subject so `/userinfo` returns the matching `sub` (unless `userinfoSubOverride` is set for mismatch tests).
- **Partner API session smoke (example)** — [`examples/auth-partner-api-session-smoke`](../../examples/auth-partner-api-session-smoke/) covers cookie session → `@plumbus/api` partner routes with `tenantId` mapping and Bearer coexistence (outside the workspace graph). The example captures `runtime.authenticator` before `initialize()` to mirror the real `createServer` wiring.

## 0.1.1 — 2026-07-26 — login application context

### Added

- **Login application context (`loginContext`).** Applications can attach a small, trusted context object when login starts and receive it in `resolveIdentity` after the callback validates — the missing piece for invitation-only registration, workspace invitations, account linking, and administrative onboarding links. Previously `resolveIdentity` saw only the verified external identity, so an unknown subject that followed a valid invitation was indistinguishable from any other unknown subject.
- **`loginContext.resolve` hook** — receives `{ providerId, returnTo, params, cookies }` and returns `{ type, data? }` or `undefined`. Runs under `timeouts.resolver`. Resolve the invitation server-side and return a derived reference (an id), never the raw token.
- **`loginContext.params`** — login-URL query parameters the application owns. They are stripped from the request **before** provider-parameter validation, so they are accepted on `/auth/login[/:provider]` and can never be appended to the authorization URL. Names must match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`, must not collide with `returnTo` or an OIDC reserved parameter, and are capped at 8 entries.
- **`loginContext.maxBytes`** — serialized context size cap. Default `1024`, ceiling `4096`. Context must be JSON-serializable and is re-serialized before sealing.
- **Optional second argument to `resolveIdentity`** — `IdentityResolutionContext`, carrying `applicationContext` when one was attached.
- **New exported types** — `AuthLoginApplicationContext`, `IdentityResolutionContext`, `LoginContextRequest`, `ResolveLoginContext`.

### Security

- Context is sealed inside the existing login transaction, so it inherits that record's guarantees: encrypted, browser-bound, single-use, and **expiring with `transactions.ttl`** (default `10m`, ceiling 6h). It has no independent lifetime and no renewal path. Expired, replayed, wrong-browser, and wrong-provider transactions fail before `resolveIdentity` runs and never surface it.
- Context is never sent to the identity provider, never written to the session cookie, never returned by `/auth/session`, never persisted in the session record, and never emitted to audit (metadata remains allowlisted to `providerId`, `reason`, `requestId`, `durationMs`).
- **Fails closed:** a hook that throws or exceeds `timeouts.resolver` fails the login start with **`503 login_unavailable`** rather than continuing without context. Oversized or non-JSON-serializable context fails with **`400 invalid_request`** before the provider redirect.
- Login context proves the attempt carried a valid invitation, **not** that the intended recipient completed it — a link holder can bind an invitation to their own identity. Cross-check the invitation against verified claims in `resolveIdentity` (requiring `email_verified`), or accept bearer-link semantics deliberately. Admission side effects must be idempotent: the transaction is already consumed when `resolveIdentity` runs, so a throw or timeout leaves a retry facing a spent invitation. See [`docs/auth/security.md`](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/security.md#login-context).

### Compatibility

**Agent wiring:** `@plumbus/core` **0.6.12** raises `AGENT_WIRING_VERSION` to 10 so generated agent instructions point coding agents at the `loginContext` admission recipe. Run `plumbus init --patch` after upgrading. Not required to use the feature — the shipped `instructions/` are read from `node_modules` either way.

Fully additive. `loginContext` is optional, the second `resolveIdentity` argument is optional, and the transaction payload field is optional (no schema version change, no migration). Existing single-argument `resolveIdentity` implementations and configs without `loginContext` behave exactly as before. Peer `@plumbus/core` unchanged at `0.6.x`; `@plumbus/auth-cognito` `0.1.x` peer range unaffected.

## 0.1.0

### Added

- OIDC RP runtime: `createAuthRuntime`, discovery, Code+PKCE(S256), opaque `__Host-plumbus_session` sessions (capped multi-session, default 5/user), CSRF via `GET /auth/session` + `X-CSRF-Token`, the six `/auth` routes, resolver hooks, memory+PostgreSQL protected stores, provider-integration contract. Peer: `@plumbus/core 0.6.x`.
- **`docs/auth/`** — human documentation and agent instructions (`instructions/`).
- **npm publish** — CI workflow publishes `@plumbus/auth` after `@plumbus/core`.
