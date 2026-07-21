# Auth Deployment

**Previous:** [migration.md](./migration.md) · **Next:** [README](./README.md)

Production checklist for `@plumbus/auth` on `@plumbus/core` 0.6.x.

---

## Package versions

| Package | Peer |
|---|---|
| `@plumbus/auth` | `@plumbus/core` **`0.6.x`** |
| `@plumbus/auth-cognito` | `@plumbus/auth` **`0.1.x`** |

Install production deps with **npm** in Docker (`npm install --omit=dev`) — copy peer literals from [`peer-dependencies.md`](../../packages/plumbus-core/instructions/peer-dependencies.md).

---

## PostgreSQL stores

1. Ship migration `packages/auth/migrations/0001_auth_init.sql` (or merge via `plumbus migrate generate`).
2. Wire Drizzle/postgres client:

```typescript
import { createPostgresSessionStore, createPostgresLoginTransactionStore } from "@plumbus/auth/postgres";
```

3. Use distinct **`applicationId`** per deployed app sharing a cluster.

Expired row cleanup runs on a 60s sweep timer inside the runtime — ensure multiple instances are safe (delete queries are idempotent).

---

## URLs and same-site

| Setting | Production guidance |
|---|---|
| `externalBaseUrl` | Public HTTPS origin serving `/auth/*` |
| `applicationBaseUrl` | SPA HTTPS origin |
| `deployment.assumeSameSite` | **`false`** — fix URL layout instead of disabling checks |

Split-domain setups (API vs SPA) require CORS allowing credentials from the SPA origin and CSRF headers on mutations.

### Shared-host platforms

Do **not** rely on `SameSite` alone when the API and other tenants share a parent domain (`*.vercel.app`, `*.herokuapp.com`, etc.). Use a **dedicated hostname** for production and keep **`__Host-` session cookies** (host-only, no `Domain` attribute) so cookies are not visible to sibling subdomains. See [security.md](./security.md#shared-host-and-subdomain-platforms).

---

## Secrets (minimum)

```bash
OKTA_CLIENT_SECRET=...
AUTH_SESSION_HMAC_SECRET=...      # storage protection
AUTH_PRINCIPAL_KEY=...            # envelope key
AUTH_TX_KEY=...                   # login transaction envelope
```

Load via `{ env: 'VAR' }` in config — never commit literals.

When using **`authenticationRuntime`**, Plumbus **`auth.secret`** is optional (core 0.6.8+).

---

## Health and observability

- Call **`authenticationRuntime.describeHealth?.()`** — degraded when any provider discovery fails.
- Monitor audit events (`auth.login.failed`, etc.) via your `AuditWriter` sink.
- Optional **`AuthMetrics`** hook in `createAuthRuntime(config, { metrics })` for discovery latency and session events.

---

## Multi-instance

- Session and transaction stores **must be shared** (PostgreSQL) — memory stores are single-process only.
- Sticky sessions are **not** required; any instance can validate any session row.
- Login transactions are single-use — load balancers may round-robin callback handling.

---

## Worker and job contexts

Background workers bootstrapped without HTTP should use **`serviceAccounts`** or explicit **`system`** auth — not browser session cookies. Flow steps triggered by users retain the **auth snapshot** from login (see [security model](../security/security-model.md)).

---

## Related docs

- [Plumbus deployment instructions](../../packages/plumbus-core/instructions/deployment.md)
- [configuration.md](./configuration.md)
- [security.md](./security.md)
