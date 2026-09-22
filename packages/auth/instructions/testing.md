# Testing Auth

## Fake OIDC provider

```ts
import { startFakeOidcProvider } from "@plumbus/auth/testing";

const fake = await startFakeOidcProvider();
// fake.issuer

// Multi-user: append fake_sub before following the authorize redirect
const authorizeUrl = new URL(loginLocation);
authorizeUrl.searchParams.set("fake_sub", "user-b");
```

Point provider registration at `fake.issuer`. Tear down in `afterAll`. Prefer `fake_sub` (query or POST body) over restarting the provider when a test needs a different subject.

## Memory stores + assumeSameSite

```ts
deployment: { assumeSameSite: true },
sessionStore: createMemorySessionStore(),
transactionStore: createMemoryLoginTransactionStore(),
storageProtection: {
  mode: "development",
  secrets: { "session-id-hmac": "01234567890123456789012345678901" },
},
```

## Integration test flow

1. `GET /auth/login` → 302 to fake authorize
2. Follow redirect to callback with `code` + `state`
3. Assert session cookie
4. `GET /auth/session` → authenticated + csrfToken
5. Protected capability with cookie + CSRF → success
6. Missing CSRF on POST → 403

Use `@plumbus/core/testing` `createTestServer({ authenticationRuntime })` when available.

## Reference implementation

Copy patterns from `packages/auth/src/__tests__/integration.test.ts` and `packages/auth/src/flow/__tests__/security-negatives.test.ts`.

## Critical rules

- **Test through HTTP routes** — not by mocking `ctx.auth` for auth behavior coverage.
- **Use fake provider** — do not hit real IdPs in CI.
- **Clean up** `startFakeOidcProvider` listeners to avoid port leaks.

Human docs: [docs/auth/testing.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/testing.md).
