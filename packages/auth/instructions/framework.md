# @plumbus/auth — Framework

`@plumbus/auth` is the **OIDC relying-party runtime** for Plumbus browser applications: hosted login redirect, authorization code + PKCE callback, opaque server sessions, CSRF, and protected PostgreSQL or memory stores. It is an **optional add-on** peer of `@plumbus/core` (version-locked **`0.6.x`**).

**`package.json` peer (framework releases):** `"@plumbus/core": "0.6.x"` — copy literally; see `packages/plumbus-core/instructions/peer-dependencies.md`.

## Package boundary

| Concern | Owned by |
|---|---|
| `HttpAuthenticationRuntime`, `RequestAuthenticator`, composite bearer/session precedence | `@plumbus/core` |
| `createAuthRuntime`, `/auth/*` routes, session + transaction stores, OIDC login flow | `@plumbus/auth` |
| Access policy evaluation | `@plumbus/core` (unchanged) |
| `AuditWriter` injection | `@plumbus/core` — optional sink wired into auth runtime |
| Cognito hosted UI param allowlist, logout URL builder | `@plumbus/auth-cognito` |

## When to install

```bash
pnpm add @plumbus/auth
```

Install when the app needs **browser login** with **HttpOnly session cookies**. Skip when all traffic uses bearer JWT/OIDC adapters only (`createJwtAdapter`, `createOidcAdapter`).

If agent wiring predates the current template, run `plumbus init --patch` after install. Wiring at **`AGENT_WIRING_VERSION` 9+** references this folder; **10+** also points at the `loginContext` admission recipe in [resolvers.md](./resolvers.md).

## Public exports

```ts
// from '@plumbus/auth'
createAuthRuntime(config, opts?)
validateAuthRuntimeConfig(config)
runAuthDiagnostics(config)
createStorageProtection(config, opts)
randomToken()
createMemorySessionStore()
createMemoryLoginTransactionStore()
AuthAuditEvents, sanitizeAuditMetadata

// types: ResolveIdentity, ResolveAuthorization, VerifiedExternalIdentity,
//        AuthLoginApplicationContext, IdentityResolutionContext,
//        LoginContextRequest, ResolveLoginContext

// from '@plumbus/auth/postgres'
createPostgresSessionStore(db)
createPostgresLoginTransactionStore(db)

// from '@plumbus/auth/testing'
startFakeOidcProvider(opts?)
pkceChallengeFromVerifier(verifier)
```

## File map (`src/`)

```
src/
├── index.ts                 # public barrel
├── runtime/create-runtime.ts
├── config/                  # validate, types, same-site
├── flow/login-flow.ts       # PKCE + callback
├── routes/register.ts       # six /auth routes
├── sessions/                # cookie, manager, CSRF
├── transactions/            # login state + binding cookie
├── providers/               # discovery, availability, integration
├── resolvers/               # identity + authorization execution
├── stores/                  # memory + postgres
├── crypto/                  # protection, envelope, keys
└── testing/                 # fake OIDC provider
```

## Symptom → answer

| The app needs… / you hit… | Read |
|---|---|
| "Admission depends on **how login started**" — invitation-only signup, workspace invite, account linking, onboarding or recovery link | [resolvers.md](./resolvers.md#invitation-only-admission-logincontext) — `loginContext` |
| "`resolveIdentity` has no user context, but an invite has no user yet" | Same. `resolveIdentity` takes an optional **second argument** carrying app context sealed into the login transaction |
| `400 invalid_request` after adding a query param to `/auth/login/:provider` | Undeclared params are validated as **provider** params. Declare app-owned params under `loginContext.params` |
| `503 login_unavailable` at login start | The app's `loginContext.resolve` hook threw or exceeded `timeouts.resolver` — login fails closed by design |
| Need to pass state through the IdP round trip | Never use `returnTo` or provider params for trusted state — use `loginContext` |

## Critical rules

1. **Never bypass Plumbus auth for capabilities.** Session auth populates `ctx.auth`; handlers still declare `access` policies.
2. **Do not issue JWT session cookies.** Opaque server sessions only.
3. **Production stores must be shared.** Memory stores are single-process dev/test only.
4. **`@plumbus/core` MUST NOT import from `@plumbus/auth`.** Wire at app bootstrap only.
5. **Frontend `@plumbus/ui` auth helpers default to localStorage bearer** — adapt for cookie sessions (see [sessions-and-csrf.md](./sessions-and-csrf.md)).
6. **Session auth assumes XSS-free frontend.** Deploy CSP; same-origin XSS can read CSRF tokens from `/auth/session` and make authenticated requests.
7. **Trusted admission state goes through `loginContext`.** Do not smuggle invitation tokens through `returnTo`, provider params, or a pre-login cookie, and do not admit unknown identities "temporarily" to gate them afterwards.

Human docs: `docs/auth/` in the monorepo.
