# Configure Auth Runtime

Recipe for wiring `@plumbus/auth` into a Plumbus app bootstrap.

## 1. Install and migrate

```bash
pnpm add @plumbus/auth
# production: apply packages/auth/migrations/0001_auth_init.sql via plumbus migrate
```

## 2. Implement stores

**Development / tests:**

```ts
import {
  createMemorySessionStore,
  createMemoryLoginTransactionStore,
} from "@plumbus/auth";
```

**Production:**

```ts
import {
  createPostgresSessionStore,
  createPostgresLoginTransactionStore,
} from "@plumbus/auth/postgres";
```

## 3. Implement resolvers

See [resolvers.md](./resolvers.md). Minimum viable:

```ts
resolveIdentity: async (identity) => {
  const user = await users.findByOidcSubject(identity.issuer, identity.subject);
  return user ? { status: "admitted", userId: user.id } : { status: "denied" };
},

resolveAuthorization: async (principal) => {
  const membership = await loadMembership(principal.userId);
  if (membership.revoked) return { status: "revoked" };
  return {
    status: "authorized",
    roles: membership.roles,
    scopes: membership.scopes,
    tenantId: membership.tenantId,
  };
},
```

## 3b. Optional — login context for invitation-only admission

Only when new users must arrive through an invitation (or account-link / onboarding link). Skip otherwise.

```ts
loginContext: {
  params: ["invite"],           // app-owned login-URL params, never sent to the IdP
  resolve: async ({ params }) => {
    const invitation = await db.invitations.findUsable(params.invite);
    return invitation ? { type: "invitation", data: { invitationId: invitation.id } } : undefined;
  },
},
```

`resolveIdentity` then receives `context.applicationContext` after the callback validates. Full rules in [resolvers.md](./resolvers.md#invitation-only-admission-logincontext). Context is sealed in the login transaction and expires with `transactions.ttl` (default `10m`).

## 4. Build runtime

```ts
import { createAuthRuntime } from "@plumbus/auth";
import { createDatabaseAuditWriter } from "@plumbus/core";

export const authenticationRuntime = createAuthRuntime(
  {
    applicationId: "my-app",
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    externalBaseUrl: process.env.API_PUBLIC_URL!,
    applicationBaseUrl: process.env.APP_PUBLIC_URL!,
    defaultReturnPath: "/",
    errorPath: "/login/error",
    session: { ttl: "7d" },
    sessionStore,
    transactionStore,
    storageProtection: {
      mode: "production",
      secrets: {
        "session-id-hmac": process.env.AUTH_SESSION_HMAC_SECRET!,
        // additional envelope keys per security.md
      },
    },
    providers: {
      /* see providers.md */
    },
    defaultProvider: "okta",
    resolveIdentity,
    resolveAuthorization,
    auditWriter: createDatabaseAuditWriter(db),
  },
  {
    // optional: bearer adapter for machine clients
  },
);
```

## 5. Pass to createServer

```ts
import { createServer } from "@plumbus/core";

await createServer({
  capabilities,
  entities,
  config,
  authenticationRuntime,
});
```

Core calls `initialize()`, registers routes, and uses `authenticationRuntime.authenticator` in the route generator.

## 6. Config file

Set `auth.provider: 'custom'` when not using default JWT. With `authenticationRuntime` present, **`auth.secret` is not required** (core 0.6.8+).

## Do not

- Register duplicate `/auth/login` or `/auth/callback` routes in app code.
- Set `ctx.auth` manually in middleware — use the runtime authenticator.
- Use memory stores in multi-instance production.
- Append undeclared query params to `/auth/login` URLs — declare them under `loginContext.params` or they are rejected as provider params.

Human docs: [docs/auth/getting-started.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/getting-started.md).
