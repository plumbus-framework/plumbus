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

### Per-request subjects (`fake_sub`)

By default the fake IdP issues `subOverride` from startup options, or `test-subject`. For multi-user tests, pass a test-only `fake_sub` on the authorize request (query on `GET /authorize`, or form body on `POST /authorize`):

```typescript
const authorizeUrl = new URL(loginRes.headers.location!);
authorizeUrl.searchParams.set("fake_sub", "user-b");
await fetch(authorizeUrl, { redirect: "manual" });
```

The issued code / ID token / access token use that subject. `/userinfo` returns the subject bound to the access token (unless `userinfoSubOverride` is set for mismatch negatives). `issueCodeFor({ sub })` remains available when you craft callbacks without hitting `/authorize`.

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
5. Call a protected capability **or partner `/api/v1/*` route** with cookie (+ CSRF on mutations) → **200**, with `ctx.auth.tenantId` populated when authorization resolves a tenant
6. `POST /auth/logout` with CSRF → session cleared

Partner routes require `registerApiRoutes` with the same `requestAuthenticator` from `authenticationRuntime` (as `createServer` does). End-to-end cookie → partner API smoke: [`examples/auth-partner-api-session-smoke`](../../examples/auth-partner-api-session-smoke/). Canonical `/auth/*` flow: [`packages/auth/src/__tests__/integration.test.ts`](../../packages/auth/src/__tests__/integration.test.ts).

---

## Login context tests

When the app configures `loginContext` ([configuration.md](./configuration.md#login-context)), test admission end to end rather than calling the hook directly:

```typescript
// 1. start login with the app-owned param
const login = await app.inject({ method: "GET", url: "/auth/login/test?invite=inv_1" });
const binding = login.headers["set-cookie"];

// 2. the param must not reach the IdP
expect(login.headers.location).not.toContain("invite");
expect(Object.keys(fake.lastAuthorizeParams ?? {})).not.toContain("invite");

// 3. complete the callback — resolveIdentity receives the sealed context
const callback = await app.inject({ method: "GET", url: callbackPath, headers: { cookie: binding } });
expect(resolverCalls[0].context.applicationContext).toEqual({
  type: "invitation",
  data: { invitationId: "inv_1" },
});
```

Worth covering in app tests:

- Login **without** the param → resolver sees no `applicationContext` → denied
- Hook throwing → `503 login_unavailable`; oversized or non-JSON context → `400 invalid_request`
- Expired transaction (advance the injected `clock` past `transactions.ttl`), replayed callback, missing binding cookie, mismatched provider → resolver never runs
- Context absent from `GET /auth/session` and from captured audit metadata

Inject `createAuthRuntime(config, { clock })` with a mutable clock to test TTL expiry without waiting. See [`packages/auth/src/flow/__tests__/login-context.test.ts`](../../packages/auth/src/flow/__tests__/login-context.test.ts) for the full suite.

---

## Security negative tests

The package includes tests for:

- CSRF failures on mutating routes
- Invalid or expired login transactions
- Provider param injection blocked by integration allowlists
- Session cap eviction
- Login context withheld on expired, replayed, wrong-browser, and wrong-provider transactions

Mirror these patterns when adding app-specific resolver tests.

---

## Cognito unit tests

`@plumbus/auth-cognito` tests integration validation and URL builders without a live AWS account. Import `cognito()` and assert hosted-login params and logout URLs in app tests when customizing Cognito options.

---

## Agent instructions

Prescriptive test recipes: [`packages/auth/instructions/testing.md`](../../packages/auth/instructions/testing.md).
