# @plumbus/auth — Agent Instructions

This folder ships with the npm tarball. It is the entry point for AI coding agents working in a Plumbus app that has `@plumbus/auth` installed. Read these files when wiring OIDC login, server sessions, CSRF, or `createServer({ authenticationRuntime })`.

These files are **prescriptive** (do this, don't do that). For conceptual docs, read `docs/auth/` in the Plumbus repository (linked from the package README).

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Package map, core vs auth boundary, critical rules. |
| [configure-runtime.md](./configure-runtime.md) | Wiring `createAuthRuntime` and bootstrap. |
| [providers.md](./providers.md) | OIDC provider registration and integrations. |
| [sessions-and-csrf.md](./sessions-and-csrf.md) | Cookie session + CSRF contract for SPAs. |
| [resolvers.md](./resolvers.md) | `resolveIdentity` and `resolveAuthorization` hooks, invitation-only admission. |
| [testing.md](./testing.md) | Fake OIDC provider and integration tests. |

For Amazon Cognito, read `node_modules/@plumbus/auth-cognito/instructions/` when that package is installed.

## Critical rules

- **Framework-first.** Login and session state belong in `@plumbus/auth` routes — do not re-implement OAuth redirect/callback handlers as ad-hoc Fastify routes.
- **Use `authenticationRuntime`.** Pass the return value of `createAuthRuntime()` to `createServer({ authenticationRuntime })` — do not bypass with a hand-rolled session middleware.
- **Resolvers are app-owned.** Map external `sub` → `userId` in `resolveIdentity`; map `userId` → roles/scopes/tenant in `resolveAuthorization`.
- **Admission context goes through `loginContext`.** Invitation and account-link flows attach trusted context via the config hook — do not smuggle app state through `returnTo` or provider params.
- **CSRF on mutations.** Browser clients must send `X-CSRF-Token` from `GET /auth/session` on `POST`/`PUT`/`PATCH`/`DELETE`.
- **Bearer optional.** Machine clients may use `createAuthRuntime(config, { bearer })` — bearer wins over session cookie in composite auth.
- **Do not store OIDC tokens in cookies.** Sessions are opaque server-side records only.

Package quickstart: [../README.md](../README.md).
