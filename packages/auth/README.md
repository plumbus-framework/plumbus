# @plumbus/auth

OIDC relying-party runtime for Plumbus applications: hosted login redirect, authorization code + PKCE callback, opaque **`__Host-plumbus_session`** cookies, CSRF for mutating requests, and protected session/transaction stores (memory or PostgreSQL).

Peer: `@plumbus/core` at **`0.6.x`**.

## Install

```bash
pnpm add @plumbus/auth
```

Optional Cognito helpers: `pnpm add @plumbus/auth-cognito`

## Quick start

```typescript
import {
  createAuthRuntime,
  createMemorySessionStore,
  createMemoryLoginTransactionStore,
} from "@plumbus/auth";
import { createServer } from "@plumbus/core";

const authenticationRuntime = createAuthRuntime({
  applicationId: "my-app",
  environment: "development",
  externalBaseUrl: process.env.AUTH_EXTERNAL_BASE_URL!,
  applicationBaseUrl: process.env.AUTH_APPLICATION_BASE_URL!,
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
    },
  },
  defaultProvider: "okta",
  resolveIdentity: async (identity) => ({
    status: "admitted",
    userId: await mapSubjectToUserId(identity.subject),
  }),
  resolveAuthorization: async (principal) => ({
    status: "authorized",
    roles: await loadRoles(principal.userId),
    scopes: [],
  }),
});

await createServer({ authenticationRuntime /* … */ });
```

## Invitation-only admission

Apps that admit new users only through invitations attach trusted context when login starts and receive it in `resolveIdentity`:

```typescript
loginContext: {
  params: ["invite"],           // app-owned login-URL param — never sent to the IdP
  resolve: async ({ params }) => {
    const invitation = await invitations.findUsable(params.invite);
    return invitation ? { type: "invitation", data: { invitationId: invitation.id } } : undefined;
  },
},

resolveIdentity: async (identity, context) => {
  const invitationId = context?.applicationContext?.data?.invitationId;
  // …admit known users; admit unknown users only with a valid invitation
},
```

The context is sealed in the login transaction — single-use, browser-bound, and expiring with `transactions.ttl` (default `10m`). See [`docs/auth/configuration.md`](../../docs/auth/configuration.md#login-context).

## Routes

Default prefix **`/auth`**: `providers`, `login`, `login/:provider`, `callback/:provider`, `session`, `logout`.

Browsers probe **`GET /auth/session`** and send **`X-CSRF-Token`** on mutations.

## Exports

| Subpath | Purpose |
|---|---|
| `@plumbus/auth` | `createAuthRuntime`, memory stores, diagnostics, types |
| `@plumbus/auth/postgres` | PostgreSQL session + transaction stores |
| `@plumbus/auth/testing` | `startFakeOidcProvider()` for integration tests |

## Documentation

- **Human docs:** [`docs/auth/`](../../docs/auth/) in the monorepo
- **Agent instructions:** [`instructions/`](./instructions/) (shipped in npm tarball)

## Migrations

SQL: [`migrations/0001_auth_init.sql`](./migrations/0001_auth_init.sql) — `auth_sessions`, `auth_login_transactions`.

## The Plumbus ecosystem

`@plumbus/auth` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Full documentation** — [docs/auth/](../../docs/auth/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
