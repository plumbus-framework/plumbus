# Auth × partner API session smoke

A self-contained smoke for **GitHub issue #46**: `@plumbus/auth` cookie sessions
must authenticate `@plumbus/api` partner routes (`/api/v1/*`) without minting a
partner JWT.

It is **not** part of the pnpm workspace and installs nothing. It imports built
`dist/` from `@plumbus/core`, `@plumbus/auth`, and `@plumbus/api`, and resolves
`fastify` from the auth package's `node_modules`.

## What it verifies

| Check | Expected |
|---|---|
| Login via fake OIDC with `fake_sub=user-a` | Session cookie + `/auth/session` authenticated |
| `GET /api/v1/refunds/r1` with cookie only (no `Authorization`) | `200` with `userId` / `tenantId` from session |
| Second login with `fake_sub=user-b` | Different principal on the partner route |
| `Authorization: Bearer machine-…` | JWT path still works (coexistence) |
| Partner call with no credentials | `401 unauthenticated` |
| `POST /api/v1/refunds/…/approve` with cookie but no CSRF | `403 csrf_failed` |
| Same POST with `Origin` + `X-CSRF-Token` | `200` approved |

## Prerequisites

```bash
# from the repo root
pnpm --filter @plumbus/core --filter @plumbus/auth --filter @plumbus/api build
```

No Postgres, Cognito, or `.env` required — the fake OIDC provider from
`@plumbus/auth/testing` runs in-process.

## Run

```bash
cd examples/auth-partner-api-session-smoke
node smoke.mjs
```

Exit code `0` when all checks pass.

## Why this lives under `examples/`

Cross-package smoke should not create a workspace `devDependency` from
`@plumbus/auth` → `@plumbus/api` (or the reverse). Unit coverage for
`requestAuthenticator` on partner routes stays in `@plumbus/api` tests; this
script is the end-to-end wiring check you can run by hand or in an optional CI job.
