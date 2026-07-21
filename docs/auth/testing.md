# Testing Auth

**Previous:** [security.md](./security.md) · **Next:** [migration.md](./migration.md)

Integration tests should exercise the real `/auth/*` routes and composite authenticator — not mock `ctx.auth` unless unit-testing an isolated handler.

---

## Fake OIDC provider

`@plumbus/auth/testing` exports **`startFakeOidcProvider()`** — a local HTTP issuer that speaks discovery, authorization redirect, and token exchange with PKCE.

```typescript
import { startFakeOidcProvider, pkceChallengeFromVerifier } from "@plumbus/auth/testing";
import { createAuthRuntime, createMemorySessionStore, createMemoryLoginTransactionStore } from "@plumbus/auth";
```

The fake provider returns configurable claims on the ID token. Point `externalBaseUrl` at your Fastify test server and register the fake issuer URL in `providers.test.issuer`.

---

## Test bootstrap pattern

```typescript
import { createTestServer } from "@plumbus/core/testing";

const fake = await startFakeOidcProvider();

const authenticationRuntime = createAuthRuntime({
  applicationId: "test-app",
  environment: "development",
  externalBaseUrl: serverUrl,
  applicationBaseUrl: serverUrl,
  defaultReturnPath: "/",
  errorPath: "/error",
  session: { ttl: "1h" },
  sessionStore: createMemorySessionStore(),
  transactionStore: createMemoryLoginTransactionStore(),
  storageProtection: {
    activeKey: { id: "k1", value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  },
  providers: {
    test: {
      type: "oidc",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: { literal: fake.clientSecret },
      scopes: ["openid"],
    },
  },
  defaultProvider: "test",
  resolveIdentity: async () => ({ status: "admitted", userId: "usr_test" }),
  resolveAuthorization: async () => ({ status: "authorized", roles: ["admin"], scopes: [] }),
  deployment: { assumeSameSite: true },
});

const app = await createTestServer({ authenticationRuntime, /* capabilities */ });
```

Use **`deployment.assumeSameSite: true`** when external and application URLs differ only by port in tests.

---

## Login flow assertion

1. `GET /auth/login` → follow redirect to fake authorize URL
2. Fake provider redirects to `/auth/callback/test?code=…&state=…`
3. Assert **`Set-Cookie`** with session cookie
4. `GET /auth/session` → `authenticated: true` + `csrfToken`
5. Call a protected capability with cookie + CSRF → **200**
6. `POST /auth/logout` with CSRF → session cleared

See [`packages/auth/src/__tests__/integration.test.ts`](../../packages/auth/src/__tests__/integration.test.ts) for the canonical flow.

---

## Security negative tests

The package includes tests for:

- CSRF failures on mutating routes
- Invalid or expired login transactions
- Provider param injection blocked by integration allowlists
- Session cap eviction

Mirror these patterns when adding app-specific resolver tests.

---

## Cognito unit tests

`@plumbus/auth-cognito` tests integration validation and URL builders without a live AWS account. Import `cognito()` and assert hosted-login params and logout URLs in app tests when customizing Cognito options.

---

## Agent instructions

Prescriptive test recipes: [`packages/auth/instructions/testing.md`](../../packages/auth/instructions/testing.md).
