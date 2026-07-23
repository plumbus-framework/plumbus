# Auth (`@plumbus/auth`)

Federated OIDC login and opaque server sessions for Plumbus applications. The runtime lives in [`packages/auth`](../../packages/auth). Amazon Cognito helpers live in [`packages/auth-cognito`](../../packages/auth-cognito).

These docs are split in two:

- **Usage** (the files in this folder) — how to install, configure, secure, test, and deploy browser login with server sessions.
- **Agent instructions** — prescriptive recipes for AI coding agents. Lives at [`packages/auth/instructions/`](../../packages/auth/instructions/) and ships in the npm tarball. Cognito-specific recipes live in [`packages/auth-cognito/instructions/`](../../packages/auth-cognito/instructions/).

## Usage docs

| Doc | Read when… |
|---|---|
| [getting-started.md](./getting-started.md) | You want the minimal wiring: install, stores, resolvers, `createServer({ authenticationRuntime })`. |
| [configuration.md](./configuration.md) | You need the full `AuthRuntimeConfig` shape, URLs, TTLs, and storage protection. |
| [providers.md](./providers.md) | You are registering OIDC providers, discovery, integrations, or provider logout. |
| [sessions-and-csrf.md](./sessions-and-csrf.md) | You are wiring the frontend to `/auth/session`, CSRF headers, or same-site cookies. |
| [cognito.md](./cognito.md) | Your IdP is Amazon Cognito — pool setup, hosted UI, and `@plumbus/auth-cognito`. |
| [security.md](./security.md) | You need threat-model notes, cookie flags, envelope encryption, and audit events. |
| [testing.md](./testing.md) | You are writing integration tests with the fake OIDC provider. |
| [migration.md](./migration.md) | You are moving from JWT-in-localStorage or a custom adapter to `@plumbus/auth`. |
| [deployment.md](./deployment.md) | You are shipping production: PostgreSQL stores, secrets, health, and multi-instance behavior. |

## When to reach for `@plumbus/auth` vs. core adapters

| You want… | Reach for |
|---|---|
| Stateless bearer JWT verified on every request (API-only, no browser login UI) | `createJwtAdapter()` or `createOidcAdapter()` in `@plumbus/core` |
| Browser login redirect, opaque `__Host-` session cookie, CSRF for mutating requests | **`@plumbus/auth`** |
| Amazon Cognito hosted UI with identity-provider pinning | **`@plumbus/auth`** + **`@plumbus/auth-cognito`** |
| MCP agent tokens or partner API client credentials | Existing `@plumbus/mcp` / `@plumbus/api` auth — not this package |

`@plumbus/auth` implements the **`HttpAuthenticationRuntime`** seam introduced in `@plumbus/core` 0.6.8. It registers `/auth/*` routes, owns session storage, and supplies the composite `RequestAuthenticator` (bearer wins over session cookie).

## Architecture in one paragraph

The app registers one or more OIDC providers. Login starts a short-lived **login transaction** (state + PKCE + browser binding cookie), redirects to the IdP, and on callback verifies the authorization code, runs **`resolveIdentity`** (admit or deny the external subject), creates an opaque session in the configured store, and sets a **`__Host-plumbus_session`** cookie. Subsequent HTTP requests authenticate via that cookie (with CSRF on mutating verbs) or an optional bearer adapter passed to `createAuthRuntime`. Before handler execution, **`resolveAuthorization`** maps the session principal to roles, scopes, and optional `tenantId` for Plumbus access policies. Protected PostgreSQL stores seal principal payloads and CSRF hashes with app-owned storage protection keys.

## Relationship to `@plumbus/core`

| Concern | Owned by | Used here as |
|---|---|---|
| `HttpAuthenticationRuntime`, `RequestAuthenticator`, composite bearer/session precedence | core | implemented by `createAuthRuntime()` |
| Access policy evaluation (`evaluateAccess`) | core | unchanged — auth runtime only populates `ctx.auth` |
| Audit sink (`AuditWriter`, `createDatabaseAuditWriter`) | core | optional injection into auth runtime |
| HTTP cookie parsing, duration parsing | core | shared utilities in route generator |
| Drizzle migrations for app entities | core | auth ships its own SQL migration for session/transaction tables |

## Public routes (default `basePath: /auth`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/providers` | Discoverable provider list + availability |
| GET | `/auth/login` | Start login with `defaultProvider` |
| GET | `/auth/login/:provider` | Start login for a specific provider |
| GET | `/auth/callback/:provider` | OIDC authorization code callback |
| GET | `/auth/session` | Session probe + CSRF token for the SPA |
| POST | `/auth/logout` | End session (CSRF required) |

## Agent instructions

When extending a Plumbus app with federated login, read the package instructions (available under `node_modules/@plumbus/auth/instructions/` after install):

- [`instructions/framework.md`](../../packages/auth/instructions/framework.md) — package boundary and critical rules
- [`instructions/configure-runtime.md`](../../packages/auth/instructions/configure-runtime.md) — wiring recipe
- [`instructions/providers.md`](../../packages/auth/instructions/providers.md) — OIDC registration
- [`instructions/sessions-and-csrf.md`](../../packages/auth/instructions/sessions-and-csrf.md) — frontend contract
- [`instructions/resolvers.md`](../../packages/auth/instructions/resolvers.md) — identity and authorization hooks
- [`instructions/testing.md`](../../packages/auth/instructions/testing.md) — fake OIDC provider

For Cognito, see [`packages/auth-cognito/instructions/`](../../packages/auth-cognito/instructions/).
