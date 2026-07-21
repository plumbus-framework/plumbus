# Getting Started with `@plumbus/auth`

**Previous:** [README](./README.md) · **Next:** [configuration.md](./configuration.md)

This guide wires the minimum OIDC relying-party runtime: install packages, configure stores, implement resolver hooks, and pass `authenticationRuntime` to `createServer()`.

---

## Prerequisites

- `@plumbus/core` **0.6.x**
- PostgreSQL (recommended for production) or in-memory stores (local dev / tests)
- An OIDC provider (Auth0, Okta, Keycloak, Amazon Cognito, etc.)
- `@plumbus/core` `0.6.8+` for `HttpAuthenticationRuntime` and composite request authentication

---

## Install

```bash
pnpm add @plumbus/auth
pnpm add @plumbus/auth-cognito   # optional — Amazon Cognito hosted UI helpers
```

Do **not** add `openid-client` to the app `package.json` — `@plumbus/auth` owns that dependency.

---

## Minimal bootstrap

```typescript
import { createAuthRuntime, createMemorySessionStore, createMemoryLoginTransactionStore } from "@plumbus/auth";
import { createServer } from "@plumbus/core";

const authenticationRuntime = createAuthRuntime({
  applicationId: "my-app",
  environment: "development",
  externalBaseUrl: "http://localhost:3000",
  applicationBaseUrl: "http://localhost:3001",
  defaultReturnPath: "/",
  errorPath: "/login/error",

  session: { ttl: "7d" },
  sessionStore: createMemorySessionStore(),
  transactionStore: createMemoryLoginTransactionStore(),

  storageProtection: {
    activeKey: {
      id: "k1",
      value: process.env.AUTH_STORAGE_KEY!, // 32-byte secret (64 hex chars)
    },
  },

  providers: {
    okta: {
      type: "oidc",
      issuer: "https://example.okta.com/oauth2/default",
      clientId: process.env.OKTA_CLIENT_ID!,
      clientSecret: { env: "OKTA_CLIENT_SECRET" },
      scopes: ["openid", "profile", "email"],
      discoverable: true,
      display: { label: "Okta" },
    },
  },
  defaultProvider: "okta",

  resolveIdentity: async (identity) => {
    // Map issuer+subject to your app's userId — deny unknown users
    const user = await findUserBySubject(identity.subject);
    return user ? { status: "admitted", userId: user.id } : { status: "denied" };
  },

  resolveAuthorization: async (principal) => ({
    status: "authorized",
    roles: ["user"],
    scopes: [],
    tenantId: await lookupTenantForUser(principal.userId),
  }),
});

const server = await createServer({
  // ...capabilities, entities, config
  authenticationRuntime,
});
```

With `authenticationRuntime` supplied, **`auth.secret` is not required** in Plumbus config — session auth replaces the default JWT adapter for browser traffic. You may still pass a bearer `AuthAdapter` as the second argument for machine clients:

```typescript
createAuthRuntime(config, { bearer: createOidcAdapter({ /* … */ }) });
```

Regenerate the frontend with **`plumbus ui generate --auth-transport session`** (or `ui nextjs --auth-transport session`) so generated helpers use credentialed fetch and in-memory CSRF instead of localStorage bearer tokens.

---

## Frontend session probe

Browser clients call **`GET /auth/session`** with `credentials: "include"`. When authenticated, the response includes a **`csrfToken`**. Mutating API calls must send:

- `credentials: "include"` (session cookie)
- `X-CSRF-Token: <csrfToken>` on `POST`, `PUT`, `PATCH`, `DELETE`

See [sessions-and-csrf.md](./sessions-and-csrf.md) for the full contract.

---

## PostgreSQL stores (production)

Replace memory stores with `@plumbus/auth/postgres` after applying the package migration:

```bash
plumbus migrate generate   # include auth tables from @plumbus/auth migrations
plumbus migrate apply
```

```typescript
import { createPostgresSessionStore, createPostgresLoginTransactionStore } from "@plumbus/auth/postgres";
```

See [deployment.md](./deployment.md) for secrets, same-site URLs, and health checks.

---

## Agent instruction wiring

After installing auth packages, refresh AI agent wiring so coding agents read `@plumbus/auth` instructions:

```bash
plumbus doctor          # detects stale wiring (version < 9)
plumbus init --patch    # updates managed blocks only; preserves your edits outside markers
```

Bare `plumbus init` **skips existing** agent files — use `--patch` or `--force`. `plumbus init` writes `AGENTS.md`, Cursor rules, and Copilot instructions; copy references to `CLAUDE.md` manually if your workflow uses it.

See [migration.md](./migration.md#agent-wiring) for the v9 auth instruction upgrade.

---

## Next steps

| Topic | Doc |
|---|---|
| Full config reference | [configuration.md](./configuration.md) |
| Provider registration | [providers.md](./providers.md) |
| Cognito | [cognito.md](./cognito.md) |
| Tests | [testing.md](./testing.md) |
